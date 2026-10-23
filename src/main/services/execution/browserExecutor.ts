import type { WorkflowNode } from '../../../shared/nodeSchema'
import {
  ExecutorError,
  type Executor,
  type ExecutorContext,
  type ExecutorResult,
  type BrowserActionMeta
} from './executors'
import {
  runBrowserOperation,
  type BrowserOperationResult,
  type BrowserRunnerDeps
} from './browserRunner'
import type { BrowserbaseCredentials } from './browserbase'
import type { ArtifactStore } from '../artifacts'
import type { Logger } from '../../lib/log'

/**
 * The browser-action executor: adapts the shared executor contract to
 * the real Browserbase runner. Credentials are resolved through the
 * injected resolver at execution time (never embedded in the workflow,
 * never put onto outputs) and every failure becomes an honest
 * `ExecutorError` — an unfinished, refused, or cancelled operation is
 * never reported as success.
 */
export interface BrowserExecutorDeps {
  runner: BrowserRunnerDeps
  artifactStore: ArtifactStore
  logger: Logger
  credentials(): Promise<BrowserbaseCredentials | null>
  /** Engine-wide hard cap for one browser operation (ms). */
  operationTimeoutCapMs?: number
}

const DEFAULT_CAP_MS = 120_000

export function makeBrowserExecutor(deps: BrowserExecutorDeps): Executor {
  return async (_node: WorkflowNode, ctx: ExecutorContext): Promise<ExecutorResult> => {
    if (ctx.signal.cancelled) throw new ExecutorError('Blocked: cancelled before the step started.')

    const credentials = await deps.credentials()
    if (!credentials) {
      throw new ExecutorError(
        'Browserbase credentials are missing — add the API key and project ID in Settings (or via BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID).'
      )
    }

    const upstreamValues = new Map<string, string>()
    for (const [nodeId, output] of ctx.upstream) upstreamValues.set(nodeId, output.value)

    const result = await runBrowserOperation(
      {
        config: ctx.config,
        upstreamValues,
        signal: ctx.signal,
        onLog: (message) => {
          ctx.onLog?.(message)
        },
        timeoutSecondsCapMs: deps.operationTimeoutCapMs ?? DEFAULT_CAP_MS,
        saveScreenshot: (bytes) => deps.artifactStore.save(bytes, 'image/png')
      },
      deps.runner,
      credentials,
      deps.logger
    )

    const meta = toMeta(result)
    return {
      value: primaryValue(result, ctx.config),
      meta
    }
  }
}

function toMeta(result: BrowserOperationResult): BrowserActionMeta {
  return {
    operation: result.operation,
    finalUrl: result.finalUrl,
    pageTitle: result.pageTitle,
    textChars: result.text === null ? null : result.extractedChars,
    textTruncated: result.textTruncated,
    screenshotId: result.screenshotId,
    sessionId: result.sessionId,
    durationMs: result.durationMs
  }
}

/**
 * The string downstream nodes see. For extract operations that is the
 * real (possibly empty) extracted text; otherwise a concise real fact:
 * the final URL, or the page title for pageInfo checks.
 */
function primaryValue(result: BrowserOperationResult, _config: Record<string, unknown>): string {
  switch (result.operation) {
    case 'extractText':
    case 'extractPageText':
      return result.text ?? ''
    case 'pageInfo':
      return `${result.pageTitle ?? ''} — ${result.finalUrl ?? ''}`.replace(/ — $/, '')
    case 'screenshot':
      return `screenshot ${result.screenshotId}${result.finalUrl ? ` of ${result.finalUrl}` : ''}`
    default:
      return result.finalUrl ?? result.pageTitle ?? ''
  }
}
