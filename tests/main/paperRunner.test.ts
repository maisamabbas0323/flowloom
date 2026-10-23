import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { paperConfigSchema, WORKFLOW_SCHEMA_VERSION } from '../../src/shared/nodeSchema'
import type { PaperInstrumentsConfig } from '../../src/shared/nodeSchema'
import type { WorkflowGraph, WorkflowNode, WorkflowRecord } from '../../src/shared/contracts'
import { isTerminalRunStatus } from '../../src/shared/runTypes'
import type { RunEvent, RunRecord, RunStatus } from '../../src/shared/runTypes'
import type { Logger } from '../../src/main/lib/log'
import { createRedactor } from '../../src/main/lib/log'
import { WorkflowService } from '../../src/main/services/workflows'
import { RunHistoryService } from '../../src/main/services/runHistory'
import { ExecutionEngine } from '../../src/main/services/execution/engine'
import { makePaperExecutor } from '../../src/main/services/execution/paperExecutor'
import { runPaperOperation, validateJsonDocument, PAPER_OUTPUT_LIMIT } from '../../src/main/services/execution/paperRunner'
import { setPaperExecutor } from '../../src/main/services/execution/executors'
import { ExecutorError, type CancellationSignal } from '../../src/main/services/execution/executors'
import type { FetchLike, FetchResponseLike } from '../../src/main/providers/types'
import { PAPER_INSTRUMENTS_BASE_URL } from '../../src/main/providers/paperinstruments'

/**
 * Paper Instruments run-path tests: the operation runner, the executor
 * adapter, and the engine integration. Everything runs against
 * controlled mock HTTP responses — no network, no billable request, no
 * live credentials. Refusals (spending stop, missing credentials) are
 * proven by asserting the generation endpoint is never reached.
 */

interface MockRoute {
  match(url: string, method: string): boolean
  respond(): { status: number; body?: string }
  seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>
}

function makeFetch(routes: MockRoute[]): FetchLike {
  return async (url, init) => {
    const route = routes.find((r) => r.match(url, init.method))
    if (!route) throw new Error(`No mock route for ${init.method} ${url}`)
    route.seen.push({ url, method: init.method, headers: init.headers, body: init.body })
    const answer = route.respond()
    const response: FetchResponseLike = {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: String(answer.status),
      text: async () => answer.body ?? '',
      arrayBuffer: async () => new ArrayBuffer(0)
    }
    return response
  }
}

const usageRoute = (seen: MockRoute['seen'], body: string): MockRoute => ({
  match: (url, method) => url === `${PAPER_INSTRUMENTS_BASE_URL}/usage` && method === 'GET',
  respond: () => ({ status: 200, body }),
  seen
})

const completionRoute = (seen: MockRoute['seen'], body: string): MockRoute => ({
  match: (url, method) => url === `${PAPER_INSTRUMENTS_BASE_URL}/chat/completions` && method === 'POST',
  respond: () => ({ status: 200, body }),
  seen
})

function completionBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 18 },
    ...extra
  })
}

function paperConfig(overrides: Partial<PaperInstrumentsConfig> = {}): PaperInstrumentsConfig {
  const parsed = paperConfigSchema.safeParse({
    name: 'Generate summary',
    prompt: 'Summarize the source text.',
    ...overrides
  })
  if (!parsed.success) throw new Error(`bad fixture config: ${JSON.stringify(parsed.error.issues)}`)
  return parsed.data
}

function signal(over: Partial<CancellationSignal> = {}): CancellationSignal {
  return { cancelled: false, listeners: new Set(), ...over }
}

/** Load a balanced 0–64k usage/read combination, sparing the type narrows. */
const SUCCESS_COMPLETION = () => completionBody('The referenced text is only a greeting.')

describe('runPaperOperation', () => {
  it('sends one generation request with the resolved template and returns the real reply', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [completionRoute(seen, SUCCESS_COMPLETION())]
    const result = await runPaperOperation(
      {
        config: paperConfig({ prompt: 'Summarize {{src1}}' }),
        model: 'pi-model-a',
        balanceStopUsd: 0,
        upstreamValues: new Map([['src1', 'hello feature']]),
        signal: signal()
      } as never,
      { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
    )
    const record = result
    expect(record.value).toBe('The referenced text is only a greeting.')
    expect(record.truncated).toBe(false)
    expect(record.structured).toBe(false)
    expect(record.balanceAvailableUsd).toBeNull() // stop disabled → no balance read
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`${PAPER_INSTRUMENTS_BASE_URL}/chat/completions`)
    const body = JSON.parse(seen[0]?.body ?? '{}') as { messages: Array<{ role: string; content: string }>; model: string }
    expect(body.model).toBe('pi-model-a')
    expect(body.messages.at(-1)?.content).toContain('hello feature')
  })

  it('refuses under the spending stop BEFORE any generation request, quoting the real balance', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [usageRoute(seen, '{"available_nanodollars":2000000000}'), completionRoute(seen, '{}')]
    await expect(
      runPaperOperation(
        {
          config: paperConfig(),
          model: 'pi-model-a',
          balanceStopUsd: 10,
          upstreamValues: new Map(),
          signal: signal()
        } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toThrow(/below the configured stop/)
    expect(seen).toHaveLength(1) // the generation POST never happened
    expect(seen[0]?.url).toContain('/usage')
  })

  it('refuses when the balance cannot be read and the stop is active — with no figures invented', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [usageRoute(seen, '<not-json>'), completionRoute(seen, '{}')]
    await expect(
      runPaperOperation(
        { config: paperConfig(), model: 'pi-model-a', balanceStopUsd: 1, upstreamValues: new Map(), signal: signal() } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toThrow(/could not be read.*generation was not started/i)
    expect(seen).toHaveLength(1)
  })

  it('skips the balance check entirely when the stop is 0', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [completionRoute(seen, SUCCESS_COMPLETION())]
    const result = await runPaperOperation(
      { config: paperConfig(), model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
      { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
    )
    
    expect(seen).toHaveLength(1)
  })

  it('marks a length-limited reply as truncated, not as invented text', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [completionRoute(seen, completionBody('partial text', { choices: [{ message: { content: 'partial text' }, finish_reason: 'length' }] }))]
    const result = await runPaperOperation(
      { config: paperConfig(), model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
      { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
    )
    
    expect(result.truncated).toBe(true)
  })

  it('clamps oversized replies to the documented downstream ceiling', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [completionRoute(seen, completionBody('x'.repeat(PAPER_OUTPUT_LIMIT + 500)))]
    const result = await runPaperOperation(
      { config: paperConfig(), model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
      { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
    )
    
    expect(result.value.length).toBe(PAPER_OUTPUT_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('validates structured replies against the supported JSON-schema subset', async () => {
    const schema = '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}'
    const seen: MockRoute['seen'] = []
    const routes = [completionRoute(seen, completionBody(JSON.stringify({ summary: 'The page is live.' })))]
    const config = paperConfig({ responseSchema: schema })
    const result = await runPaperOperation(
      { config, model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
      { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
    )
    
    expect(result.structured).toBe(true)
    const parsed = JSON.parse(result.value) as { summary?: string }
    expect(parsed['summary']).toBe('The page is live.')
  })

  it('fails honestly when a structured reply misses a required field', async () => {
    const schema = '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}'
    const routes = [completionRoute([], completionBody(JSON.stringify({ notes: 'wrong shape' })))]
    const config = paperConfig({ responseSchema: schema })
    await expect(
      runPaperOperation(
        { config, model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toThrow(/required field "summary"/)
  })

  it('fails honestly when a structured reply with additionalProperties:false carries extra fields', async () => {
    const schema = '{"type":"object","properties":{"summary":{"type":"string"}},"additionalProperties":false}'
    const routes = [completionRoute([], completionBody(JSON.stringify({ summary: 'ok', extra: 'no' })))]
    const config = paperConfig({ responseSchema: schema })
    await expect(
      runPaperOperation(
        { config, model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toThrow(/not in the schema/)
  })

  it('fails honestly when a structured reply is not JSON at all', async () => {
    const schema = '{"type":"object","properties":{"summary":{"type":"string"}}}'
    const routes = [completionRoute([], completionBody('plain text answer'))]
    const config = paperConfig({ responseSchema: schema })
    await expect(
      runPaperOperation(
        { config, model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toThrow(/not valid JSON/)
  })

  it('refuses before any request when the run is already cancelled', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [usageRoute(seen, '{}'), completionRoute(seen, '{}')]
    await expect(
      runPaperOperation(
        { config: paperConfig(), model: 'pi-model-a', balanceStopUsd: 1, upstreamValues: new Map(), signal: signal({ cancelled: true }) } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toThrow(/cancelled/i)
    expect(seen).toHaveLength(0)
  })

  it('propagates unresolved template references as loud errors', async () => {
    const routes = [completionRoute([], '{}')]
    await expect(
      runPaperOperation(
        { config: paperConfig({ prompt: 'Reply about {{missing_node}}' }), model: 'pi-model-a', balanceStopUsd: 0, upstreamValues: new Map(), signal: signal() } as never,
        { fetch: makeFetch(routes), credentials: { apiKey: 'pi_live_test' } }
      )
    ).rejects.toBeInstanceOf(ExecutorError)
  })
})

describe('JSON-schema subset validator (local, bounded, honest about being a subset)', () => {
  it('checks types, string bounds, and patterns', () => {
    expect(validateJsonDocument('abc', { type: 'string', minLength: 4 }).ok).toBe(false)
    expect(validateJsonDocument('abcd', { type: 'string', minLength: 4 }).ok).toBe(true)
    expect(validateJsonDocument('abcd', { type: 'string', pattern: '^ab' }).ok).toBe(true)
    expect(validateJsonDocument('abcd', { type: 'string', pattern: '^cd' }).ok).toBe(false)
    expect(validateJsonDocument(3, { type: 'integer' }).ok).toBe(true)
    expect(validateJsonDocument(3.5, { type: 'integer' }).ok).toBe(false)
  })

  it('checks constants, enums, and numeric bounds', () => {
    expect(validateJsonDocument('yes', { const: 'yes' }).ok).toBe(true)
    expect(validateJsonDocument('no', { const: 'yes' }).ok).toBe(false)
    expect(validateJsonDocument('b', { enum: ['a', 'b'] }).ok).toBe(true)
    expect(validateJsonDocument('c', { enum: ['a', 'b'] }).ok).toBe(false)
    expect(validateJsonDocument(1, { type: 'number', minimum: 0, maximum: 10 }).ok).toBe(true)
    expect(validateJsonDocument(11, { type: 'number', maximum: 10 }).ok).toBe(false)
  })

  it('checks arrays and nested objects', () => {
    expect(validateJsonDocument(['a', 'b'], { type: 'array', minItems: 1, maxItems: 2 }).ok).toBe(true)
    expect(validateJsonDocument([1, 'x'], { type: 'array', items: { type: 'number' } }).ok).toBe(false)
    const check = validateJsonDocument({ list: [{ n: 1 }] }, {
      type: 'object',
      properties: { list: { items: { type: 'object', properties: { n: { type: 'number' } } } } }
    })
    expect(check.ok).toBe(true)
  })

  it('ignores unknown keywords and still demands a JSON-object schema', () => {
    expect(validateJsonDocument('x', { type: 'string', format: 'email' }).ok).toBe(true)
    expect(validateJsonDocument('x', 'not-a-json-object' as never).ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* Executor adapter                                                    */
/* ------------------------------------------------------------------ */

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe('makePaperExecutor', () => {
  it('refuses while disabled without touching the network', async () => {
    const routes = [completionRoute([], '{}')]
    const executor = makePaperExecutor({
      fetch: makeFetch(routes),
      logger,
      credentials: () => ({ apiKey: 'pi_live_test' }),
      effectiveModel: () => 'pi-model-a',
      enabled: () => false,
      minBalanceUsd: () => 0
    })
    await expect(
      executor(
        { id: 'p1', type: 'paperInstruments', position: { x: 0, y: 0 }, config: {} } as unknown as WorkflowNode,
        { config: {}, input: null, upstream: new Map(), signal: signal() }
      )
    ).rejects.toThrow(/switched off/)
    void routes
  })

  it('refuses without credentials and without touching the network', async () => {
    const routes = [completionRoute([], '{}')]
    const executor = makePaperExecutor({
      fetch: makeFetch(routes),
      logger,
      credentials: () => null,
      effectiveModel: () => 'pi-model-a',
      enabled: () => true,
      minBalanceUsd: () => 0
    })
    await expect(
      executor(
        { id: 'p1', type: 'paperInstruments', position: { x: 0, y: 0 }, config: {} } as unknown as WorkflowNode,
        { config: paperConfig(), input: null, upstream: new Map(), signal: signal() }
      )
    ).rejects.toThrow(/credentials are missing/)
    expect(routes).toHaveLength(1) // constructed, never requested
  })

  it('refuses when no model exists anywhere — never invents one', async () => {
    const executor = makePaperExecutor({
      fetch: makeFetch([]),
      logger,
      credentials: () => ({ apiKey: 'pi_live_test' }),
      effectiveModel: () => '',
      enabled: () => true,
      minBalanceUsd: () => 0
    })
    await expect(
      executor(
        { id: 'p1', type: 'paperInstruments', position: { x: 0, y: 0 }, config: {} } as unknown as WorkflowNode,
        { config: paperConfig(), input: null, upstream: new Map(), signal: signal() }
      )
    ).rejects.toThrow(/never guesses a model name/)
  })

  it('prefers the node-level model and publishes usage-carrying metadata', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [completionRoute(seen, SUCCESS_COMPLETION())]
    const executor = makePaperExecutor({
      fetch: makeFetch(routes),
      logger,
      credentials: () => ({ apiKey: 'pi_live_test' }),
      effectiveModel: () => 'settings-fallback-model',
      enabled: () => true,
      minBalanceUsd: () => 0
    })
    const output = await executor(
      { id: 'p1', type: 'paperInstruments', position: { x: 0, y: 0 }, config: {} } as unknown as WorkflowNode,
      { config: paperConfig({ model: '', prompt: 'plain prompt' }), input: null, upstream: new Map(), signal: signal() }
    )
    expect('model' in (output.meta ?? {})).toBe(true)
    expect((output.meta as { model: string }).model).toBe('settings-fallback-model')
    expect((output.meta as { totalTokens: number | null }).totalTokens).toBe(18)
  })
})

/* ------------------------------------------------------------------ */
/* Engine integration                                                  */
/* ------------------------------------------------------------------ */

function node(id: string, type: WorkflowNode['type'] | string, config: Record<string, unknown> = {}, x = 0, y = 0): WorkflowNode {
  return { id, type, position: { x, y }, config } as unknown as WorkflowNode
}

function edge(id: string, source: string, target: string, sourceHandle?: string) {
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target }
}

async function tick(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('engine + Paper Instruments node', () => {
  let dir: string
  let service: WorkflowService
  let history: RunHistoryService
  let events: RunEvent[]
  let engine: ExecutionEngine

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-paper-run-'))
    service = new WorkflowService(dir, logger)
    history = new RunHistoryService(path.join(dir, 'runs'), logger)
    events = []
    engine = new ExecutionEngine({
      workflows: service,
      history,
      redactor: createRedactor(),
      logger,
      publish: (event) => events.push(event)
    })
  })

  afterEach(() => {
    engine.shutdown()
    setPaperExecutor(null)
    void tick(60).then(() => fs.rmSync(dir, { recursive: true, force: true }))
  })

  async function persistWorkflow(name: string, graph: WorkflowGraph): Promise<WorkflowRecord['id']> {
    const created = service.create({ name })
    const saved = service.save({ id: created.id, name, graph })
    if (!saved.ok) throw new Error(`fixture rejected: ${JSON.stringify(saved.errors)}`)
    return created.id
  }

  async function waitForTerminal(eventsRef: RunEvent[]): Promise<RunStatus> {
    const started = Date.now()
    for (;;) {
      for (let i = eventsRef.length - 1; i >= 0; i -= 1) {
        const event = eventsRef[i]
        if (event.type === 'workflow' && isTerminalRunStatus(event.status)) return event.status
      }
      if (Date.now() - started > 5_000) throw new Error(`run did not finish within 5s (events: ${JSON.stringify(eventsRef)})`)
      await tick(10)
    }
  }

  async function waitForHistory(runId: string): Promise<RunRecord> {
    const started = Date.now()
    for (;;) {
      const record = await history.get(runId)
      if (record && isTerminalRunStatus(record.status)) return record
      if (Date.now() - started > 5_000) throw new Error(`history never reached terminal for ${runId}`)
      await tick(20)
    }
  }

  it('runs a text → generation flow end-to-end with the mocked provider and records the generation meta', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [
      completionRoute(seen, JSON.stringify({
        choices: [{ message: { content: 'The reply from the paper model.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 }, total_tokens: 16 }
      }))
    ]
    setPaperExecutor(
      makePaperExecutor({
        fetch: makeFetch(routes),
        logger,
        credentials: () => ({ apiKey: 'pi_live_test' }),
        effectiveModel: () => 'settings-fallback-model',
        enabled: () => true,
        minBalanceUsd: () => 0
      })
    )
    const workflowId = await persistWorkflow(
      'Paper pipeline',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: 'raw page text' }),
          node('gen1', 'paperInstruments', { name: 'Ask the model', prompt: 'Summarize {{data1}}' })
        ],
        edges: [edge('e1', 'trig1', 'data1'), edge('e2', 'data1', 'gen1')]
      }
    )
    const started = engine.start(workflowId)
    expect(started.ok).toBe(true)
    const status = await waitForTerminal(events)
    expect(status).toBe('succeeded')
    expect(seen).toHaveLength(1)

    const runId = started.ok ? started.runId : null
    const record = await waitForHistory(runId as string)
    const generated = record.nodes.find((entry) => entry.nodeId === 'gen1')
    expect(generated?.status).toBe('succeeded')
    const meta = generated?.meta
    expect(meta !== undefined && 'model' in meta).toBe(true)
    if (meta !== undefined && 'model' in meta) {
      expect(meta.model).toBe('settings-fallback-model')
      expect(meta.finishReason).toBe('stop')
      expect(meta.totalTokens).toBe(16)
      expect(meta.reasoningTokens).toBe(2)
    }
    // The generated text reached downstream through the template,
    // and the provider's usage numbers were recorded — never estimated.
    expect(seen[0]?.headers['Authorization']).toBe('Bearer pi_live_test')
  })

  it('pushes the refusal through the engine as a failed step when the spending stop bites', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [usageRoute(seen, '{"available_nanodollars":1000000}'), completionRoute(seen, '{}')]
    setPaperExecutor(
      makePaperExecutor({
        fetch: makeFetch(routes),
        logger,
        credentials: () => ({ apiKey: 'pi_live_test' }),
        effectiveModel: () => 'settings-fallback-model',
        enabled: () => true,
        minBalanceUsd: () => 5
      })
    )
    const workflowId = await persistWorkflow(
      'Stopped run',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('gen1', 'paperInstruments', { name: 'Ask the model', prompt: 'Summarize the page' })
        ],
        edges: [edge('e1', 'trig1', 'gen1')]
      }
    )
    const started = engine.start(workflowId)
    expect(started.ok).toBe(true)
    const status = await waitForTerminal(events)
    expect(status).toBe('failed')
    expect(seen).toHaveLength(1) // only the free usage read; no generation
    expect(seen[0]?.url).toContain('/usage')
  })
})
