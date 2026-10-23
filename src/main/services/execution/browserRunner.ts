import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import {
  browserActionConfigSchema,
  checkNavigationUrl,
  hasValidReferenceSyntax,
  resolveTemplate,
  type BrowserActionConfig
} from '../../../shared/nodeSchema'
import { ExecutorError, type CancellationSignal } from './executors'
import {
  createBrowserbaseClient,
  type BrowserbaseClient,
  type BrowserbaseCredentials
} from './browserbase'
import type { Logger } from '../../lib/log'

/**
 * The real browser-operation runner.
 *
 * Session model: Flowloom creates one short-lived Browserbase session
 * per browser-action execution (documented cost), connects once over
 * CDP using the API-provided `connectUrl` (never logged), drives the
 * pre-created default context/page, and always releases the session in
 * a `finally` — success, failure, timeout, or cancellation. The release
 * uses the documented `REQUEST_RELEASE` update so no stray sessions are
 * left running; a 404 there means the session already ended on its own.
 *
 * Every public operation path throws `ExecutorError` with a safe,
 * secret-free message on failure. Success produces a bounded, real
 * result — never a fabricated value.
 */

export interface BrowserOperationResult {
  operation: BrowserActionConfig['action']
  sessionId: string
  durationMs: number
  finalUrl: string | null
  pageTitle: string | null
  /** Extracted text (extract actions) — may truthfully be empty. */
  text: string | null
  textTruncated: boolean
  extractedChars: number
  screenshotId: string | null
}

export interface BrowserRunnerDeps {
  connectOverCDP(url: string): Promise<Browser>
  createClient(credentials: BrowserbaseCredentials): BrowserbaseClient
}

export function createDefaultRunnerDeps(): BrowserRunnerDeps {
  // `playwright-core`'s CDP connect needs no local browser binaries —
  // the remote Browserbase chromium is the target.
  return {
    connectOverCDP: (url: string) => chromium.connectOverCDP(url),
    createClient: (credentials) => createBrowserbaseClient(globalThis.fetch, credentials)
  }
}

export interface BrowserRunRequest {
  config: Record<string, unknown>
  /** Resolved plain values keyed by upstream node id (safe references). */
  upstreamValues: Map<string, string>
  signal: CancellationSignal
  onLog: (message: string) => void
  timeoutSecondsCapMs: number
  saveScreenshot: (bytes: Buffer) => Promise<string>
}

/** Runs one browser action end-to-end, owning the whole session lifecycle. */
export async function runBrowserOperation(
  request: BrowserRunRequest,
  deps: BrowserRunnerDeps,
  credentials: BrowserbaseCredentials,
  logger: Logger
): Promise<BrowserOperationResult> {
  const parsed = browserActionConfigSchema.safeParse(request.config)
  if (!parsed.success) {
    throw new ExecutorError('The browser step is not fully configured — finish it in the inspector.')
  }
  const config = parsed.data
  const startMs = Date.now()

  if (config.action === 'navigate') {
    const check = checkNavigationUrl(config.url ?? '')
    if (!check.ok) throw new ExecutorError(`Navigation refused: ${check.error}`)
  }

  // Resolve safe {{nodeId}} references in text fields against finished
  // upstream outputs only. No eval, no Function — plain substitution.
  const targetUrl = resolvedField(config.url, request.upstreamValues, 'URL')
  const fillValue = resolvedField(config.value, request.upstreamValues, 'input value')
  const selector = (config.selector ?? '').trim()

  const timeoutS = config.timeoutSeconds
  const timeoutMs = Math.max(1000, Math.min(timeoutS * 1000, request.timeoutSecondsCapMs))

  const session = await createSessionOrThrow(deps, credentials, timeoutS, request.onLog)
  const { client } = session
  const connectUrl = session.connectUrl
  const sessionId = session.id

  let browser: Browser | null = null
  let cancelClose: (() => void) | null = null
  const onCancel = (): void => {
    request.onLog('Cancellation requested — closing the browser session.')
    cancelClose?.()
  }
  request.signal.listeners.add(onCancel)

  try {
    request.onLog(`Connecting to browser session ${sessionId}…`)
    try {
      browser = await withTimeout(deps.connectOverCDP(connectUrl), 30_000, 'Connecting to the browser session timed out.')
    } catch (error) {
      if (request.signal.cancelled) throw new ExecutorError('Cancelled while connecting to the browser session.')
      throw new ExecutorError(`Could not connect to the Browserbase browser session: ${describeBrowserError(error)}`)
    }
    if (request.signal.cancelled) throw new ExecutorError('Cancelled before the browser action started.')
    cancelClose = () => {
      void browser?.close().catch(() => undefined)
    }

    const context = pickContext(browser)
    const page = await ensurePage(context)
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)

    const result = await performOperation({ config, page, targetUrl, fillValue, selector, timeoutMs }, request)
    return {
      ...result,
      sessionId,
      durationMs: Date.now() - startMs
    }
  } finally {
    request.signal.listeners.delete(onCancel)
    // Session cleanup always runs: disconnect the CDP browser first
    // (safe even when it already died), then release via the REST API.
    try {
      await browser?.close()
    } catch {
      // A browser that died mid-operation cannot be closed again; the
      // REST release below remains the cleanup authority.
    }
    const release = await client.releaseSession(sessionId)
    if (release === 'unconfirmed') {
      logger.warn(`Browser session ${sessionId} release could not be confirmed — check the Browserbase dashboard.`)
      request.onLog('The browser session was closed, but its release could not be confirmed.')
    } else if (release === 'released') {
      request.onLog(`Browser session ${sessionId} released.`)
    }
  }
}

interface OperationArgs {
  config: BrowserActionConfig
  page: Page
  targetUrl: URLValue | null
  fillValue: URLValue | null
  selector: string
  timeoutMs: number
}

type URLValue = { ok: true; value: string } | { ok: false; error: string }

async function performOperation(args: OperationArgs, request: BrowserRunRequest): Promise<Omit<BrowserOperationResult, 'sessionId' | 'durationMs'>> {
  const { config, page, targetUrl, fillValue, selector, timeoutMs } = args
  const needsSelector =
    config.action === 'extractText' ||
    config.action === 'click' ||
    config.action === 'fillField' ||
    config.action === 'waitFor'
  if (needsSelector && selector === '') {
    throw new ExecutorError('This browser operation needs an element selector — finish the step in the inspector.')
  }
  const needsFillValue = config.action === 'fillField'
  if (needsFillValue && fillValue === null) {
    throw new ExecutorError('This browser operation needs the text to fill in.')
  }
  const result: Omit<BrowserOperationResult, 'sessionId' | 'durationMs'> = {
    operation: config.action,
    finalUrl: null,
    pageTitle: null,
    text: null,
    textTruncated: false,
    extractedChars: 0,
    screenshotId: null
  }

  if (config.action === 'navigate' && targetUrl && !targetUrl.ok) {
    throw new ExecutorError(targetUrl.error)
  }
  if (fillValue && !fillValue.ok) throw new ExecutorError(fillValue.error)

  // Every action accepts an optional destination. Only `navigate`
  // requires one; the others treat it as "navigate to this page first"
  // — the natural way to aim an extraction/click/screenshot at a live
  // page, since each browser action owns its own short-lived session.
  if (config.action !== 'navigate' && targetUrl && !targetUrl.ok) {
    throw new ExecutorError(targetUrl.error)
  }
  if (config.action !== 'navigate' && targetUrl?.ok) {
    await navigate(page, targetUrl.value, timeoutMs, request)
  }

  switch (config.action) {
    case 'navigate': {
      if (!targetUrl || !targetUrl.ok) {
        throw new ExecutorError('This browser operation needs a valid destination URL.')
      }
      await navigate(page, targetUrl.value, timeoutMs, request)
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      break
    }
    case 'extractPageText': {
      await settlePage(page)
      const text = await extractWholePageText(page, timeoutMs)
      result.text = bounded(text, config.limit)
      result.textTruncated = text.length > result.text.length
      result.extractedChars = result.text.length
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      request.onLog(`Extracted ${result.extractedChars} characters of page text.`)
      break
    }
    case 'extractText': {
      await settlePage(page)
      await waitSelector(page, selector, timeoutMs)
      const text = await page.locator(selector).first().innerText({ timeout: timeoutMs })
      result.text = bounded(text ?? '', config.limit)
      result.textTruncated = (text ?? '').length > result.text.length
      result.extractedChars = result.text.length
      request.onLog(`Extracted ${result.extractedChars} characters from ${selector}.`)
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      break
    }
    case 'click': {
      await waitSelector(page, selector, timeoutMs)
      await page.locator(selector).first().click({ timeout: timeoutMs })
      request.onLog(`Clicked ${selector}.`)
      await settlePage(page)
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      break
    }
    case 'fillField': {
      await waitSelector(page, selector, timeoutMs)
      await page.locator(selector).first().fill(fillValue!.ok ? fillValue!.value : '', { timeout: timeoutMs })
      request.onLog(`Filled ${selector} (${(fillValue?.ok ? fillValue.value : '').length} characters).`)
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      break
    }
    case 'waitFor': {
      await waitSelector(page, selector, timeoutMs)
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      request.onLog(`Element ${selector} is present.`)
      break
    }
    case 'pageInfo': {
      await settlePage(page)
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      request.onLog(`Page: ${result.pageTitle ?? '(untitled)'} at ${result.finalUrl ?? 'unknown URL'}.`)
      break
    }
    case 'screenshot': {
      const bytes = await page.screenshot({ type: 'png', fullPage: config.fullPage === true, timeout: timeoutMs })
      if (bytes.length === 0) throw new ExecutorError('The browser returned an empty screenshot.')
      result.screenshotId = await request.saveScreenshot(Buffer.from(bytes))
      result.finalUrl = await readFinalUrl(page)
      result.pageTitle = await readTitle(page)
      request.onLog(`Screenshot captured (${bytes.length} bytes) as ${result.screenshotId}.`)
      break
    }
    default: {
      const exhaustive: never = config.action
      throw new ExecutorError(`Unsupported browser operation: ${String(exhaustive)}`)
    }
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function resolvedField(raw: string | undefined, upstream: Map<string, string>, label: string): URLValue | null {
  if (raw === undefined) return null
  if (!hasValidReferenceSyntax(raw)) {
    return { ok: false, error: `The ${label} contains a malformed {{reference}} — use whole node ids inside double braces.` }
  }
  const resolved = resolveTemplate(raw, upstream)
  if (!resolved.ok) return { ok: false, error: `The ${label} could not be resolved: ${resolved.error}` }
  return { ok: true, value: resolved.value }
}

async function navigate(page: Page, rawUrl: string, timeoutMs: number, request: BrowserRunRequest): Promise<void> {
  const check = checkNavigationUrl(rawUrl)
  if (!check.ok) throw new ExecutorError(`Navigation refused: ${check.error}`)
  request.onLog(`Navigating to ${check.url}…`)
  try {
    await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  } catch (error) {
    if (request.signal.cancelled) throw new ExecutorError('Cancelled while navigating.')
    throw new ExecutorError(describeNavigationError(error, check.url))
  }
  // Destination re-check: some redirects may have landed somewhere else.
  const landed = new URL(page.url())
  const landedCheck = checkNavigationUrl(landed.toString())
  if (!landedCheck.ok) {
    throw new ExecutorError(`The page redirected to a destination Flowloom does not allow (${landed.host}). Navigation stopped.`)
  }
}

function describeNavigationError(error: unknown, url: string): string {
  const name = (error as { name?: string }).name
  const message = shortMessage(error)
  if (name === 'TimeoutError') return `Navigation to ${url} timed out.`
  return `Navigation to ${url} failed: ${message || 'the page did not load'}.`
}

function shortMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/\s+/g, ' ').slice(0, 240)
}

function describeBrowserError(error: unknown): string {
  const message = shortMessage(error)
  // Never include the connect URL (it carries the session credential).
  return message.replace(/wss?:\/\/\S+/g, 'the session endpoint')
}

async function settlePage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 })
  } catch {
    // A long-loading page does not invalidate extraction of what loaded.
  }
}

async function waitSelector(page: Page, selector: string, timeoutMs: number): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout: timeoutMs })
  } catch (error) {
    if ((error as { name?: string }).name === 'TimeoutError') {
      throw new ExecutorError(`The element "${selector}" was not found within ${Math.round(timeoutMs / 1000)}s.`)
    }
    throw new ExecutorError(`Waiting for "${selector}" failed: ${shortMessage(error)}`)
  }
}

/**
 * Visible page text without arbitrary JavaScript: the runner only ever
 * reads `innerText` of the page body — no user-supplied expressions are
 * executed in the page.
 */
async function extractWholePageText(page: Page, timeoutMs: number): Promise<string> {
  try {
    return (await page.locator('body').first().innerText({ timeout: timeoutMs })) ?? ''
  } catch {
    // A page without a body (about:blank, some frames) is truthfully empty.
    return ''
  }
}

async function readFinalUrl(page: Page): Promise<string | null> {
  try {
    const url = page.url()
    return url && url !== 'about:blank' ? url : null
  } catch {
    return null
  }
}

async function readTitle(page: Page): Promise<string | null> {
  try {
    const title = await page.title()
    return title.length > 300 ? `${title.slice(0, 300)}…` : title
  } catch {
    return null
  }
}

/** Locates the pre-created default context with its blank page. */
function pickContext(browser: Browser): BrowserContext {
  const contexts = browser.contexts()
  if (contexts.length === 0) throw new ExecutorError('The browser session exposed no page contexts.')
  return contexts[0]
}

async function ensurePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()
  if (existing.length > 0) return existing[0]
  try {
    return await context.newPage()
  } catch {
    throw new ExecutorError('No usable page is available in the browser session.')
  }
}

interface CreatedSessionOk {
  id: string
  connectUrl: string
  client: BrowserbaseClient
}

async function createSessionOrThrow(
  deps: BrowserRunnerDeps,
  credentials: BrowserbaseCredentials,
  timeoutSeconds: number,
  onLog: (message: string) => void
): Promise<CreatedSessionOk> {
  const client = deps.createClient(credentials)
  onLog('Creating a browser session…')
  const created = await client.createSession({ timeoutSeconds })
  if ('kind' in created) {
    throw new ExecutorError(sessionFailureMessage(created))
  }
  return { id: created.id, connectUrl: created.connectUrl, client }
}

export function sessionFailureMessage(failure: { kind: string; message: string }): string {
  switch (failure.kind) {
    case 'auth':
      return 'Browserbase rejected the configured credentials — check the Browserbase settings.'
    case 'invalid_project':
      return failure.message
    case 'rate_limit':
      return failure.message
    case 'network':
      return failure.message
    default:
      return failure.message
  }
}

/** Bound with timeout so a hung CDP call cannot stall cleanup forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function bounded(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  return normalized.length > limit ? normalized.slice(0, limit) : normalized
}
