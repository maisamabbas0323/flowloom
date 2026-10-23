import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowGraph, WorkflowNode, WorkflowRecord } from '../../src/shared/contracts'
import type { RunEvent, RunRecord, RunStatus } from '../../src/shared/runTypes'
import { isTerminalRunStatus } from '../../src/shared/runTypes'
import { WORKFLOW_SCHEMA_VERSION } from '../../src/shared/nodeSchema'
import type { Logger } from '../../src/main/lib/log'
import { createRedactor } from '../../src/main/lib/log'
import { WorkflowService } from '../../src/main/services/workflows'
import { RunHistoryService } from '../../src/main/services/runHistory'
import { ExecutionEngine } from '../../src/main/services/execution/engine'
import { makeBrowserExecutor } from '../../src/main/services/execution/browserExecutor'
import {
  setBrowserExecutor,
  type Executor,
  type CancellationSignal
} from '../../src/main/services/execution/executors'
import type { Browser as PlaywrightBrowser } from 'playwright-core'
import type { BrowserRunnerDeps } from '../../src/main/services/execution/browserRunner'
import type { BrowserbaseClient, SessionRelease } from '../../src/main/services/execution/browserbase'
import { createArtifactStore, isArtifactId } from '../../src/main/services/artifacts'
import type { BrowserOperationMeta, PaperGenerationMeta } from '../../src/shared/runTypes'

/** Narrows the node-meta union to the browser shape the suite asserts on. */
function browserMeta(meta: BrowserOperationMeta | PaperGenerationMeta): BrowserOperationMeta {
  if (!('operation' in meta)) throw new Error('Expected browser-operation metadata.')
  return meta
}

/* -------------------------------------------------------------------- */
/* Harness                                                               */
/* -------------------------------------------------------------------- */

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

const redactor = createRedactor()
redactor.setSecrets(['bb_key_secret'])

let dir: string
let service: WorkflowService
let history: RunHistoryService
let events: RunEvent[]

const CREDENTIALS = { apiKey: 'bb_key_secret', projectId: 'proj_1' }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-browser-'))
  service = new WorkflowService(path.join(dir, 'workflows'), logger)
  history = new RunHistoryService(path.join(dir, 'runs'), logger)
  events = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function node(
  id: string,
  type: WorkflowNode['type'],
  config: Record<string, unknown>,
  x = 0,
  y = 0
): WorkflowNode {
  return { id, type, position: { x, y }, config } as unknown as WorkflowNode
}

function edge(id: string, source: string, target: string, sourceHandle?: string) {
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target }
}

async function persistWorkflow(name: string, graph: WorkflowGraph): Promise<WorkflowRecord['id']> {
  const created = service.create({ name })
  const saved = service.save({ id: created.id, name, graph })
  if (!saved.ok) throw new Error(`fixture rejected: ${JSON.stringify(saved.errors)}`)
  return created.id
}

async function waitForTerminal(eventsRef: RunEvent[], runId: string): Promise<RunStatus> {
  const started = Date.now()
  for (;;) {
    for (const event of eventsRef) {
      if (event.type === 'workflow' && event.runId === runId && isTerminalRunStatus(event.status)) {
        return event.status
      }
    }
    if (Date.now() - started > 5_000) {
      throw new Error(`run ${runId} never reached a terminal state`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function loadRun(runId: string): Promise<RunRecord> {
  const record = await history.get(runId)
  if (!record) throw new Error(`run ${runId} missing from history`)
  return record
}

/* -------------------------------------------------------------------- */
/* Fake browser                                                          */
/* -------------------------------------------------------------------- */

interface BrowserBehavior {
  extract: string
  title: string
  finalUrl: string
  /** 'never' rejects only when the browser is closed (cancellation). */
  waitFor: 'instant' | 'never' | 'late-resolve' | 'timeout-error'
  createFailure: 'auth' | 'rate_limit' | null
  releaseResults: SessionRelease[]
}

let behavior: BrowserBehavior
let sessionsCreated = 0
let sessionsReleased = 0
let connectAttempts = 0
let gotoUrls: string[]
let clickedSelectors: string[]
let filledValues: string[]
let fillSelectors: string[]
let waitedSelectors: string[]
let screenshotsTaken: { fullPage: boolean }[]
let closeSignals: Array<() => void>
let capturedCancelListener: (() => void) | null = null

function resetFakes(overrides: Partial<BrowserBehavior> = {}): void {
  behavior = {
    extract: 'Page heading\nParagraph text',
    title: 'Example page title',
    finalUrl: 'https://example.com/landed',
    waitFor: 'instant',
    createFailure: null,
    releaseResults: [],
    ...overrides
  }
  sessionsCreated = 0
  sessionsReleased = 0
  connectAttempts = 0
  gotoUrls = []
  clickedSelectors = []
  filledValues = []
  fillSelectors = []
  waitedSelectors = []
  screenshotsTaken = []
  closeSignals = []
  capturedCancelListener = null
}

function timeoutError(): Error {
  const error = new Error('Timeout 30000ms exceeded.')
  error.name = 'TimeoutError'
  return error
}

function buildRunnerDeps(): BrowserRunnerDeps {
  const client: BrowserbaseClient = {
    async createSession() {
      if (behavior.createFailure === 'auth') {
        return { kind: 'auth', message: 'Browserbase rejected the API key.' }
      }
      if (behavior.createFailure === 'rate_limit') {
        return { kind: 'rate_limit', message: 'Rate limit reached.' }
      }
      sessionsCreated += 1
      return { id: `sess_${sessionsCreated}`, status: 'PENDING', connectUrl: 'wss://session-endpoint' }
    },
    async releaseSession(_sessionId): Promise<SessionRelease> {
      sessionsReleased += 1
      if (behavior.releaseResults.length > 0) return behavior.releaseResults.shift() as SessionRelease
      return 'released'
    }
  }
  return {
    connectOverCDP: async () => {
      connectAttempts += 1
      return buildFakeBrowser() as PlaywrightBrowser
    },
    createClient: () => client
  }
}

interface LocatorAgent {
  waitFor(args: { state: string; timeout: number }): Promise<void>
  innerText(args: { timeout: number }): Promise<string>
  click(args: { timeout: number }): Promise<void>
  fill(value: string, args: { timeout: number }): Promise<void>
}

function buildFakeBrowser(): unknown {
  const page = {
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    url: () => (gotoUrls.length > 0 ? behavior.finalUrl : 'about:blank'),
    title: async () => behavior.title,
    goto: async (url: string) => {
      gotoUrls.push(url)
    },
    waitForLoadState: async () => undefined,
    evaluate: async () => behavior.extract,
    locator: (selector: string) => {
      const agent: LocatorAgent = {
        waitFor: async (args) => {
          waitedSelectors.push(selector)
          if (behavior.waitFor === 'timeout-error') throw timeoutError()
          if (behavior.waitFor === 'never') {
            await new Promise<void>((_resolve, reject) => {
              const onClose = (): void => reject(new Error('browser closed'))
              closeSignals.push(onClose)
            })
            return
          }
          if (behavior.waitFor === 'late-resolve') {
            await new Promise<void>((resolve) => {
              const onClose = (): void => {
                // Cancellation closed the browser, yet the pending CDP
                // op resolves late — exactly the race the engine must
                // survive without rewriting a cancelled run.
                setTimeout(resolve, 30)
              }
              closeSignals.push(onClose)
            })
          }
          void args
        },
        innerText: async () => behavior.extract,
        click: async () => {
          clickedSelectors.push(selector)
        },
        fill: async (value) => {
          filledValues.push(value)
          fillSelectors.push(selector)
        }
      }
      return { first: () => agent }
    },
    screenshot: async (args: { fullPage?: boolean }) => {
      screenshotsTaken.push({ fullPage: args.fullPage === true })
      return Buffer.from('fake-png-bytes')
    },
    close: async () => {
      for (const signal of [...closeSignals]) signal()
    }
  }
  return {
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    close: async () => {
      for (const signal of [...closeSignals]) signal()
    }
  }
}

function makeExecutorDeps(runner?: BrowserRunnerDeps) {
  return {
    runner: runner ?? buildRunnerDeps(),
    artifactStore: createArtifactStore(dir, logger),
    logger,
    credentials: async () => CREDENTIALS,
    operationTimeoutCapMs: 10_000
  }
}

let engine: ExecutionEngine
let executorDeps: ReturnType<typeof makeExecutorDeps>

function freshEngine(credentialGate: () => string | null = (
  () => null
)): ExecutionEngine {
  return new ExecutionEngine({
    workflows: service,
    history,
    redactor,
    logger,
    publish: (event) => events.push(event),
    credentialGate
  })
}

afterAll(() => {
  // Leave the shared registry clean for other test files.
  setBrowserExecutor(null)
})

/* -------------------------------------------------------------------- */
/* Executor unit behavior (no engine)                                    */
/* -------------------------------------------------------------------- */

function minimalSignal(cancelled = false): CancellationSignal {
  return { cancelled, listeners: new Set() }
}

describe('browser executor (unit)', () => {
  beforeEach(() => {
    resetFakes()
    executorDeps = makeExecutorDeps()
    setBrowserExecutor(makeBrowserExecutor(executorDeps))
  })

  it('navigates, publishes real metadata, and releases the session', async () => {
    const executor: Executor = makeBrowserExecutor(executorDeps)
    const logs: string[] = []
    const output = await executor(
      node('b', 'browserAction', {
        name: 'Open example',
        action: 'navigate',
        url: 'https://example.com/'
      }),
      {
        config: {
          name: 'Open example',
          action: 'navigate',
          url: 'https://example.com/'
        },
        input: null,
        upstream: new Map(),
        signal: minimalSignal(),
        onLog: (message) => logs.push(message)
      }
    )
    expect(gotoUrls).toEqual(['https://example.com/'])
    expect(output.value).toBe('https://example.com/landed')
    expect(output.meta && browserMeta(output.meta)?.operation).toBe('navigate')
    expect(output.meta && browserMeta(output.meta)?.pageTitle).toBe('Example page title')
    expect(output.meta && browserMeta(output.meta)?.sessionId).toBe('sess_1')
    expect(output.meta && browserMeta(output.meta)?.screenshotId).toBeNull()
    expect(sessionsCreated).toBe(1)
    expect(sessionsReleased).toBe(1)
    expect(connectAttempts).toBe(1)
    // Stage messages say what actually happened — nothing fabricated.
    expect(logs.some((line) => line.startsWith('Navigating to'))).toBe(true)
    expect(logs.some((line) => line.includes('released'))).toBe(true)
  })

  it('extracts page text truthfully, including a truly empty result', async () => {
    const executor: Executor = makeBrowserExecutor(executorDeps)
    const output = await executor(node('b', 'browserAction', {
      name: 'Extract',
      action: 'extractPageText'
    }), {
      config: { name: 'Extract', action: 'extractPageText' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })
    expect(output.value).toBe('Page heading\nParagraph text')
    expect(output.meta && browserMeta(output.meta)?.textChars).toBe('Page heading\nParagraph text'.length)
  })

  it('an extraction with an optional URL navigates to the page first', async () => {
    const executor: Executor = makeBrowserExecutor(makeExecutorDeps())
    const output = await executor(node('b', 'browserAction', {
      name: 'Extract',
      action: 'extractPageText',
      url: 'https://example.com/'
    }), {
      config: { name: 'Extract', action: 'extractPageText', url: 'https://example.com/' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })
    expect(output.value).toBe('Page heading\nParagraph text')
    expect(gotoUrls).toEqual(['https://example.com/'])
  })

  it('an extraction refuses a malformed optional URL instead of guessing', async () => {
    const executor: Executor = makeBrowserExecutor(makeExecutorDeps())
    const innerConfig = { name: 'Extract', action: 'extractPageText', url: 'javascript:alert(1)' }
    // The schema refuses unsafe schemes at parse time — an honest,
    // actionable refusal before any session is created.
    await expect(async () =>
      executor(node('b', 'browserAction', innerConfig), {
        config: innerConfig,
        input: null,
        upstream: new Map(),
        signal: minimalSignal(),
        onLog: () => undefined
      })
    ).rejects.toThrow(/not fully configured/)
  })

  it('reports an empty page as a success with an empty value (not an error)', async () => {
    resetFakes({ extract: '' })
    const executor: Executor = makeBrowserExecutor(makeExecutorDeps())
    const output = await executor(node('b', 'browserAction', {
      name: 'Extract empty',
      action: 'extractPageText'
    }), {
      config: { name: 'Extract empty', action: 'extractPageText' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })
    expect(output.value).toBe('')
    expect(output.meta && browserMeta(output.meta)?.textChars).toBe(0)
  })

  it('clicks and fills with a resolved selector/value', async () => {
    const executor: Executor = makeBrowserExecutor(executorDeps)
    await executor(node('b', 'browserAction', {
      name: 'Fill form',
      action: 'fillField',
      selector: '#email'
    }), {
      config: { name: 'Fill form', action: 'fillField', selector: '#email', value: 'me@example.com' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })
    expect(waitedSelectors).toEqual(['#email'])
    expect(filledValues).toEqual(['me@example.com'])
  })

  it('maps a selector timeout to an honest not-found failure', async () => {
    resetFakes({ waitFor: 'timeout-error' })
    const executor: Executor = makeBrowserExecutor(makeExecutorDeps())
    await expect(executor(node('b', 'browserAction', {
      name: 'Click',
      action: 'click',
      selector: '#missing'
    }), {
      config: { name: 'Click', action: 'click', selector: '#missing' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })).rejects.toThrow('was not found within')
    expect(sessionsReleased).toBe(1)
  })

  it('refuses unsafe navigation targets before any session is created', async () => {
    const executor: Executor = makeBrowserExecutor(executorDeps)
    await expect(executor(node('b', 'browserAction', {
      name: 'Metadata',
      action: 'navigate',
      url: 'http://169.254.169.254/latest/meta-data/'
    }), {
      config: { name: 'Metadata', action: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })).rejects.toThrow('private or internal network')
    expect(sessionsCreated).toBe(0)
    expect(connectAttempts).toBe(0)
    expect(sessionsReleased).toBe(0)
  })

  it('fails honestly on an auth rejection during session creation', async () => {
    resetFakes({ createFailure: 'auth' })
    const executor: Executor = makeBrowserExecutor(makeExecutorDeps())
    await expect(executor(node('b', 'browserAction', {
      name: 'Navigate',
      action: 'navigate',
      url: 'https://example.com/'
    }), {
      config: { name: 'Navigate', action: 'navigate', url: 'https://example.com/' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })).rejects.toThrow('rejected the configured credentials')
    expect(sessionsCreated).toBe(0)
  })

  it('fails honestly when rate limited', async () => {
    resetFakes({ createFailure: 'rate_limit' })
    const executor: Executor = makeBrowserExecutor(makeExecutorDeps())
    await expect(executor(node('b', 'browserAction', {
      name: 'Navigate',
      action: 'navigate',
      url: 'https://example.com/'
    }), {
      config: { name: 'Navigate', action: 'navigate', url: 'https://example.com/' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })).rejects.toThrow('Rate limit reached.')
  })

  it('saves screenshots as managed artifacts and references them by id', async () => {
    const executor: Executor = makeBrowserExecutor(executorDeps)
    const output = await executor(node('b', 'browserAction', {
      name: 'Screenshot',
      action: 'screenshot'
    }), {
      config: { name: 'Screenshot', action: 'screenshot', fullPage: true },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })
    expect(screenshotsTaken).toEqual([{ fullPage: true }])
    expect(output.value).toContain('screenshot ')
    expect(isArtifactId(output.value.replace(/^screenshot /, '').split(' ')[0])).toBe(true)
    expect(output.meta && browserMeta(output.meta)?.screenshotId).toMatch(/^art_[a-z0-9]{24}$/)
  })

  it('refuses to run without configured Browserbase credentials', async () => {
    const executor: Executor = makeBrowserExecutor({
      ...makeExecutorDeps(),
      credentials: async () => null
    })
    await expect(executor(node('b', 'browserAction', {
      name: 'Navigate',
      action: 'navigate',
      url: 'https://example.com/'
    }), {
      config: { name: 'Navigate', action: 'navigate', url: 'https://example.com/' },
      input: null,
      upstream: new Map(),
      signal: minimalSignal(),
      onLog: () => undefined
    })).rejects.toThrow('Browserbase credentials are missing')
    expect(sessionsCreated).toBe(0)
  })
})

/* -------------------------------------------------------------------- */
/* Engine integration                                                    */
/* -------------------------------------------------------------------- */

describe('browser actions inside real engine runs', () => {
  beforeEach(() => {
    resetFakes()
    executorDeps = makeExecutorDeps()
    setBrowserExecutor(makeBrowserExecutor(executorDeps))
    engine = freshEngine()
  })

  it('passes real browser output to a downstream text step', async () => {
    const workflowId = await persistWorkflow('Browser flow', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }),
        node('b', 'browserAction', {
          name: 'Navigate',
          action: 'navigate',
          url: 'https://example.com/'
        }, 200, 0),
        node('d', 'data', { value: 'Landed on {{b}}' }, 400, 0)
      ],
      edges: [edge('e1', 't', 'b'), edge('e2', 'b', 'd')]
    })
    const started = engine.start(workflowId)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await waitForTerminal(events, started.runId)
    expect(status).toBe('succeeded')
    const run = await loadRun(started.runId)
    const dataStep = run.nodes.find((entry) => entry.nodeId === 'd')
    expect(dataStep?.status).toBe('succeeded')
    expect(dataStep?.outputSummary).toContain('https://example.com/landed')
    const browserStep = run.nodes.find((entry) => entry.nodeId === 'b')
    expect(browserStep?.meta && browserMeta(browserStep.meta)?.operation).toBe('navigate')
    expect(browserStep?.meta && browserMeta(browserStep.meta)?.finalUrl).toBe('https://example.com/landed')
  })

  it('runs an end-to-end Trigger → Browser → Condition workflow', async () => {
    resetFakes({ extract: 'All systems operational' })
    const workflowId = await persistWorkflow('Check page', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }, 0, 0),
        node('b', 'browserAction', { name: 'Get page text', action: 'extractPageText' }, 200, 0),
        node('c', 'condition', { checkText: '{{b}}', operator: 'contains', contains: 'operational' }, 400, 0),
        node('yes', 'data', { value: 'status good: {{b}}' }, 600, -60)
      ],
      edges: [
        edge('e1', 't', 'b'),
        edge('e2', 'b', 'c'),
        edge('e3', 'c', 'yes', 'true')
      ]
    })
    const started = engine.start(workflowId)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const status = await waitForTerminal(events, started.runId)
    expect(status).toBe('succeeded')
    const run = await loadRun(started.runId)
    expect(run.nodes.find((entry) => entry.nodeId === 'c')?.status).toBe('succeeded')
    const yes = run.nodes.find((entry) => entry.nodeId === 'yes')
    expect(yes?.status).toBe('succeeded')
    expect(yes?.outputSummary).toContain('All systems operational')
  })

  it('fails the run when the browser operation fails and skips downstream', async () => {
    resetFakes({ waitFor: 'timeout-error' })
    const workflowId = await persistWorkflow('Broken browser flow', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }),
        node('b', 'browserAction', { name: 'Click ghost', action: 'click', selector: '#ghost' }, 200, 0),
        node('d', 'data', { value: 'never' }, 400, 0)
      ],
      edges: [edge('e1', 't', 'b'), edge('e2', 'b', 'd')]
    })
    const started = engine.start(workflowId)
    if (!started.ok) throw new Error('run refused')
    const status = await waitForTerminal(events, started.runId)
    expect(status).toBe('failed')
    const run = await loadRun(started.runId)
    const browserStep = run.nodes.find((entry) => entry.nodeId === 'b')
    expect(browserStep?.status).toBe('failed')
    expect(browserStep?.error ?? '').toContain('#ghost')
    expect(run.nodes.find((entry) => entry.nodeId === 'd')?.status).toBe('skipped')
    // Cleanup still happened for the created session.
    expect(sessionsCreated).toBe(1)
    expect(sessionsReleased).toBe(1)
  })

  it('refuses the run before side effects when Browserbase is unconfigured', async () => {
    const refusingEngine = freshEngine(() =>
      'Browserbase is not configured — add the API key and project ID in Settings.'
    )
    const workflowId = await persistWorkflow('Unconfigured browser', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }),
        node('b', 'browserAction', { name: 'Navigate', action: 'navigate', url: 'https://example.com/' }, 200, 0)
      ],
      edges: [edge('e1', 't', 'b')]
    })
    const started = refusingEngine.start(workflowId)
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.errors[0]).toContain('Browserbase')
    expect(started.errors[0]).not.toContain('bb_key_secret')
    expect(sessionsCreated).toBe(0)
    const summaries = await history.list()
    expect(summaries).toHaveLength(0)
  })

  it('supports condition checking on empty browser output without faking truth', async () => {
    resetFakes({ extract: '' })
    const workflowId = await persistWorkflow('Empty page', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }, 0, 0),
        node('b', 'browserAction', { name: 'Get text', action: 'extractPageText' }, 200, 0),
        node('c', 'condition', { checkText: '{{b}}', operator: 'isEmpty' }, 400, 0),
        node('empty', 'data', { value: 'page was empty' }, 600, 60)
      ],
      edges: [edge('e1', 't', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'empty', 'true')]
    })
    const started = engine.start(workflowId)
    if (!started.ok) throw new Error('run refused')
    const status = await waitForTerminal(events, started.runId)
    expect(status).toBe('succeeded')
    const run = await loadRun(started.runId)
    expect(run.nodes.find((entry) => entry.nodeId === 'empty')?.status).toBe('succeeded')
    expect(run.nodes.find((entry) => entry.nodeId === 'b')?.outputSummary).toBe('')
  })

  it('keeps a cancelled run cancelled even when the browser op resolves late', async () => {
    resetFakes({ waitFor: 'late-resolve' })
    const workflowId = await persistWorkflow('Late browser flow', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }),
        node('b', 'browserAction', { name: 'Wait for slow', action: 'waitFor', selector: '#later' }, 200, 0)
      ],
      edges: [edge('e1', 't', 'b')]
    })
    const started = engine.start(workflowId)
    if (!started.ok) throw new Error('run refused')
    const runId = started.runId
    // Cancel as soon as the browser node starts, then wait out the late
    // resolution (30 ms) plus slack.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (events.some((e) => e.type === 'node' && e.nodeId === 'b' && e.status === 'running')) {
          expect(engine.cancel(runId)).toBe(true)
          resolve()
          return
        }
        setTimeout(check, 5)
      }
      check()
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const run = await loadRun(runId)
    expect(isTerminalRunStatus(run.status)).toBe(true)
    expect(run.status).toBe('cancelled')
    const browserStep = run.nodes.find((entry) => entry.nodeId === 'b')
    expect(browserStep?.status).toBe('cancelled')
    const exhaust = vi.fn()
    void exhaust
  })

  it('responds to cancellation promptly and still releases the session', async () => {
    resetFakes({ waitFor: 'never' })
    const workflowId = await persistWorkflow('Cancel browser', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }),
        node('b', 'browserAction', { name: 'Wait forever', action: 'waitFor', selector: '#x', timeoutSeconds: 120 }, 200, 0)
      ],
      edges: [edge('e1', 't', 'b')]
    })
    const started = engine.start(workflowId)
    if (!started.ok) throw new Error('run refused')
    const runId = started.runId
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (waitedSelectors.includes('#x')) {
          engine.cancel(runId)
          resolve()
          return
        }
        setTimeout(check, 5)
      }
      check()
    })
    const status = await waitForTerminal(events, runId)
    expect(status).toBe('cancelled')
    expect(sessionsCreated).toBe(1)
    expect(sessionsReleased).toBe(1)
  })

  it('never writes credential material into history or engine events', async () => {
    resetFakes({ createFailure: 'auth' })
    const workflowId = await persistWorkflow('Secret leak probe', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        node('t', 'trigger', { kind: 'manual' }),
        node('b', 'browserAction', { name: 'Navigate', action: 'navigate', url: 'https://example.com/' }, 200, 0)
      ],
      edges: [edge('e1', 't', 'b')]
    })
    const started = engine.start(workflowId)
    if (!started.ok) throw new Error('run refused — expected the executor to run before any credential gate')
    await waitForTerminal(events, started.runId)
    const dumped = JSON.stringify(events) + JSON.stringify(await loadRun(started.runId))
    expect(dumped).not.toContain('bb_key_secret')
    expect(dumped).not.toContain('wss://session-endpoint')
  })
})
