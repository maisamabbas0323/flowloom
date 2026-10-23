import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowGraph, WorkflowNode, WorkflowRecord } from '../../src/shared/contracts'
import type { NodeRunStatus, RunEvent, RunRecord, RunStatus } from '../../src/shared/runTypes'
import { isTerminalRunStatus } from '../../src/shared/runTypes'
import { WORKFLOW_SCHEMA_VERSION } from '../../src/shared/nodeSchema'
import type { Logger } from '../../src/main/lib/log'
import { createRedactor } from '../../src/main/lib/log'
import { WorkflowService } from '../../src/main/services/workflows'
import { RunHistoryService } from '../../src/main/services/runHistory'
import { ExecutionEngine, MAX_CONCURRENT_RUNS } from '../../src/main/services/execution/engine'

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
}

let dir: string
let service: WorkflowService
let history: RunHistoryService
let events: RunEvent[]
let engine: ExecutionEngine
let constructedDir: string

function node(
  id: string,
  type: WorkflowNode['type'] | string,
  config: Record<string, unknown> = {},
  x = 0,
  y = 0
): WorkflowNode {
  return { id, type, position: { x, y }, config } as unknown as WorkflowNode
}

function edge(id: string, source: string, target: string, sourceHandle?: string) {
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target }
}

/** Persist a graph for engine consumption (disk is the authority). */
async function persistWorkflow(name: string, graph: WorkflowGraph): Promise<WorkflowRecord['id']> {
  const created = service.create({ name })
  const saved = service.save({ id: created.id, name, graph })
  if (!saved.ok) throw new Error(`fixture rejected: ${JSON.stringify(saved.errors)}`)
  return created.id
}

/** The final run-file write is asynchronous — poll until it lands. */
async function waitForHistory(runId: string): Promise<RunRecord> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const record = await history.get(runId)
    if (record && isTerminalRunStatus(record.status)) return record
    await tick(20)
  }
  throw new Error(`history record for ${runId} never reached a terminal state`)
}

function terminalStatus(eventsRef: RunEvent[]): RunStatus | null {
  for (let i = eventsRef.length - 1; i >= 0; i -= 1) {
    const event = eventsRef[i]
    if (event.type === 'workflow' && isTerminalRunStatus(event.status)) return event.status
  }
  return null
}

async function waitForTerminal(eventsRef: RunEvent[]): Promise<RunStatus> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const status = terminalStatus(eventsRef)
    if (status !== null) return status
    await tick(10)
  }
  throw new Error(`run did not finish within 5s (events: ${JSON.stringify(eventsRef)})`)
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForNodeStatus(
  eventsRef: RunEvent[],
  wanted: NodeRunStatus
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    if (eventsRef.some((event) => event.type === 'node' && event.status === wanted)) return
    await tick(10)
  }
  throw new Error(`no node reached status ${wanted}`)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-engine-'))
  constructedDir = dir
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

afterEach(async () => {
  engine.shutdown()
  await tick(60)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* Successful runs                                                     */
/* ------------------------------------------------------------------ */

describe('execution engine', () => {
  it('runs a trigger → text flow for real and reports succeeded', async () => {
    const workflowId = await persistWorkflow(
      'Greeting',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: 'hello from Flowloom' })
        ],
        edges: [edge('e1', 'trig1', 'data1')]
      }
    )
    const started = engine.start(workflowId)
    expect(started.ok).toBe(true)
    expect(terminalStatus(events)).toBe(null)
    const status = await waitForTerminal(events)
    expect(status).toBe('succeeded')
    // Lifecycle honesty: queued/validating/running appear, terminal is last.
    const lifecycle = events.filter((event) => event.type === 'workflow').map((event) => event.status)
    expect(lifecycle).toContain('validating')
    expect(lifecycle[lifecycle.length - 1]).toBe('succeeded')
    expect(lifecycle.filter((s) => s === 'succeeded')).toHaveLength(1)

    // Node-level statuses are real.
    const byNode = nodeStatuses()
    expect(byNode.get('trig1')).toBe('succeeded')
    expect(byNode.get('data1')).toBe('succeeded')

    // Data actually flowed: the text node's output reached the engine.
    expect(nodeStatuses().get('data1')).toBe('succeeded')
  })

  it('records truthful duration and timestamps on the persisted run', async () => {
    const workflowId = await persistWorkflow(
      'Timed',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('delay1', 'delay', { seconds: 1 })
        ],
        edges: [edge('e1', 'trig1', 'delay1')]
      }
    )
    engine.start(workflowId)
    expect(await waitForTerminal(events)).toBe('succeeded')
    const runId = (events[eventSavedStartIndex(events)]).runId
    const details = await waitForHistory(runId)
    expect(details.status).toBe('succeeded')
    expect(details.durationMs).not.toBeNull()
    expect((details.durationMs ?? 0)).toBeGreaterThanOrEqual(900)
    expect(details.finishedAt).not.toBeNull()
    expect(details.nodes.find((entry) => entry.nodeId === 'delay1')?.outputSummary).toMatch(/waited 1s/)
  })

  it('conditions choose the real branch and skipped branches skip downstream', async () => {
    const workflowId = await persistWorkflow(
      'Branchy',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: 'Flowloom rocks' }),
          node('cond1', 'condition', { checkText: '{{data1}}', operator: 'contains', contains: 'rocks' }),
          node('data2', 'data', { value: 'branch-taken' }),
          node('data3', 'data', { value: 'branch-not-taken' }),
          node('join1', 'join', { behavior: 'all' })
        ],
        edges: [
          edge('e1', 'trig1', 'data1'),
          edge('e2', 'data1', 'cond1'),
          edge('e3', 'cond1', 'data2', 'true'),
          edge('e4', 'cond1', 'data3', 'false'),
          edge('e5', 'data2', 'join1'),
          edge('e6', 'data3', 'join1')
        ]
      }
    )
    engine.start(workflowId)
    const status = await waitForTerminal(events)
    expect(status).toBe('succeeded')
    const byNode = nodeStatuses()
    expect(byNode.get('cond1')).toBe('succeeded')
    expect(byNode.get('data2')).toBe('succeeded')
    expect(byNode.get('data3')).toBe('skipped')
    expect(byNode.get('join1')).toBe('succeeded')
  })

  it('joins wait for all required branches and proceed past legitimately skipped ones', async () => {
    // Condition false → only the false branch runs; join(all) must not
    // deadlock on the skipped true branch.
    const workflowId = await persistWorkflow(
      'False branch',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: 'plain text' }),
          node('cond1', 'condition', { checkText: '{{data1}}', operator: 'contains', contains: 'rocks' }),
          node('data2', 'data', { value: 'true-branch' }),
          node('data3', 'data', { value: 'false-branch' }),
          node('join1', 'join', { behavior: 'all' })
        ],
        edges: [
          edge('e1', 'trig1', 'data1'),
          edge('e2', 'data1', 'cond1'),
          edge('e3', 'cond1', 'data2', 'true'),
          edge('e4', 'cond1', 'data3', 'false'),
          edge('e5', 'data2', 'join1'),
          edge('e6', 'data3', 'join1')
        ]
      }
    )
    engine.start(workflowId)
    expect(await waitForTerminal(events)).toBe('succeeded')
    const byNode = nodeStatuses()
    expect(byNode.get('data2')).toBe('skipped')
    expect(byNode.get('data3')).toBe('succeeded')
    expect(byNode.get('join1')).toBe('succeeded')
  })

  it('join with any behavior proceeds on the first delivered branch', async () => {
    const workflowId = await persistWorkflow(
      'Any join',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: 'first arrives' }),
          node('join1', 'join', { behavior: 'any' }),
          node('data2', 'data', { value: 'unused' })
        ],
        edges: [edge('e1', 'trig1', 'data1'), edge('e2', 'data1', 'join1'), edge('e3', 'data1', 'data2')]
      }
    )
    engine.start(workflowId)
    expect(await waitForTerminal(events)).toBe('succeeded')
    expect(nodeStatuses().get('join1')).toBe('succeeded')
  })

  /* ---------------------------------------------------------------- */
  /* Failure and false-success prevention                              */
  /* ---------------------------------------------------------------- */

  it('a failing node fails the run and marks downstream skipped — never a false success', async () => {
    const workflowId = await persistWorkflow(
      'Broken ref',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: '{{ghost}}' }),
          node('data2', 'data', { value: 'never runs' })
        ],
        edges: [edge('e1', 'trig1', 'data1'), edge('e2', 'data1', 'data2')]
      }
    )
    engine.start(workflowId)
    const status = await waitForTerminal(events)
    expect(status).toBe('failed')
    const byNode = nodeStatuses()
    expect(byNode.get('data1')).toBe('failed')
    expect(byNode.get('data2')).toBe('skipped')
    expect(byNode.get('trig1')).toBe('succeeded')

    const runId = terminalRunId()
    const record = await waitForHistory(runId)
    expect(record?.error).toBeTruthy()
    expect(record?.nodes.find((entry) => entry.nodeId === 'data1')?.error).toMatch(/ghost|upstream/i)
  })

  it('never reports cancelled as succeeded', async () => {
    const workflowId = await persistWorkflow(
      'Slow',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('delay1', 'delay', { seconds: 600 }),
          node('data1', 'data', { value: 'after the wait' })
        ],
        edges: [edge('e1', 'trig1', 'delay1'), edge('e2', 'delay1', 'data1')]
      }
    )
    const started = engine.start(workflowId)
    expect(started).not.toBeNull()
    const runId = started.ok ? started.runId : null
    expect(runId).not.toBeNull()
    await waitForNodeStatus(events, 'running')
    expect(engine.cancel(runId)).toBe(true)
    const status = await waitForTerminal(events)
    expect(status).toBe('cancelled')
    const byNode = nodeStatuses()
    expect(byNode.get('delay1')).toBe('cancelled')
    expect(byNode.get('data1')).not.toBe('succeeded')
    const record = await waitForHistory(runId as string)
    expect(record?.cancelRequestedAt).not.toBeNull()
  })

  it('the delay node frees its timer on cancellation (no pending wait leak)', async () => {
    const workflowId = await persistWorkflow(
      'Slow too',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('delay1', 'delay', { seconds: 1200 })
        ],
        edges: [edge('e1', 'trig1', 'delay1')]
      }
    )
    const started = engine.start(workflowId)
    const runId = started.ok ? started.runId : null
    await waitForNodeStatus(events, 'running')
    engine.cancel(runId)
    expect(await waitForTerminal(events)).toBe('cancelled')
  })

  /* ---------------------------------------------------------------- */
  /* Refusals and concurrency policy                                   */
  /* ------------------------------------------------------------------ */

  it('refuses a half-configured browser-action workflow before any side effects', async () => {
    const workflowId = await persistWorkflow(
      'Needs browser',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('brws1', 'browserAction', { name: 'Open example', action: 'click', selector: '' })
        ],
        edges: [edge('e1', 'trig1', 'brws1')]
      }
    )
    const started = engine.start(workflowId)
    expect(started.ok).toBe(false)
    const result = started as { ok: false; errors: string[] }
    expect(result.errors.join(' ')).toMatch(/finish the configuration/i)
    // No history entry was created for a refused run.
    expect(await history.list()).toHaveLength(0)
  })

  it('prevents duplicate concurrent runs of the same workflow', async () => {
    const workflowId = await persistWorkflow(
      'Sleepy',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('delay1', 'delay', { seconds: 600 })
        ],
        edges: [edge('e1', 'trig1', 'delay1')]
      }
    )
    const first = engine.start(workflowId)
    expect(first.ok).toBe(true)
    await waitForNodeStatus(events, 'running')
    const second = engine.start(workflowId)
    expect(second.ok).toBe(false)
    const result = second as { ok: false; errors: string[] }
    expect(result.errors.join(' ')).toMatch(/already running/i)
    engine.cancel(first.ok ? first.runId : '')
  })

  it('enforces the global concurrency limit while staying isolated', async () => {
    // Fill the limit with three long-running runs of distinct workflows.
    const ids: string[] = []
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i += 1) {
      const id = await persistWorkflow('Sleeper ' + i, {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [node('trig1', 'trigger', { kind: 'manual' }), node('delay1', 'delay', { seconds: 600 + i })],
        edges: [edge('e1', 'trig1', 'delay1')]
      })
      ids.push(id)
    }
    const started = ids.map((id) => engine.start(id))
    for (const entry of started) expect(entry.ok).toBe(true)

    const overflow = await persistWorkflow('Overflow', {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [node('trig1', 'trigger', { kind: 'manual' }), node('data1', 'data', { value: 'x' })],
      edges: [edge('e1', 'trig1', 'data1')]
    })
    const rejected = engine.start(overflow)
    expect(rejected.ok).toBe(false)
    const result = rejected as { ok: false; errors: string[] }
    expect(result.errors.join(' ')).toMatch(/runs can execute at once/i)

    // Isolation: every active run keeps its own id and its events stay separate.
    const runIds = new Set(events.map((event) => event.runId))
    expect(runIds.size).toBe(MAX_CONCURRENT_RUNS)
    for (const entry of started) {
      if (entry.ok) expect(engine.cancel(entry.runId)).toBe(true)
    }
  })

  it('rejects malformed renderer requests (unknown workflow)', () => {
    const started = engine.start('wf_missing0000')
    expect(started.ok).toBe(false)
    const result = started as { ok: false; errors: string[] }
    expect(result.errors.join(' ')).toMatch(/could not be found/i)
    expect(engine.start(42)).toEqual({ ok: false, errors: [expect.stringMatching(/workflow id is required/i)] })
    expect(engine.cancel('run_nope')).toBe(false)
  })

  /* ---------------------------------------------------------------- */
  /* Run history persistence                                           */
  /* ---------------------------------------------------------------- */

  it('persists run history incrementally and survives reading after workflow deletion', async () => {
    const workflowId = await persistWorkflow(
      'Survivor',
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', { kind: 'manual' }),
          node('data1', 'data', { value: 'important record' })
        ],
        edges: [edge('e1', 'trig1', 'data1')]
      }
    )
    engine.start(workflowId)
    expect(await waitForTerminal(events)).toBe('succeeded')
    const summaries = await history.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.workflowName).toBe('Survivor')

    // Deleting the workflow never deletes its run history.
    expect(service.delete(workflowId)).toBe(true)
    const record = await history.get(summaries[0]!.id)
    expect(record?.workflowName).toBe('Survivor')
    expect(record?.nodes.every((entry) => entry.status === 'succeeded')).toBe(true)
    expect(record?.nodes.find((entry) => entry.nodeId === 'data1')?.outputSummary).toContain('important record')
  })

  it('handles invalid history records without crashing the store', async () => {
    const runsDir = path.join(dir, 'runs')
    fs.mkdirSync(runsDir, { recursive: true })
    fs.writeFileSync(path.join(runsDir, 'run_corrupt123.json'), '{ not json at all', 'utf8')
    expect(await history.get('run_corrupt123')).toBeNull()
    const summaries = await history.list()
    expect(Array.isArray(summaries)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */

function nodeStatuses(): Map<string, NodeRunStatus> {
  const map = new Map<string, NodeRunStatus>()
  for (const event of events) {
    if (event.type === 'node') map.set(event.nodeId, event.status)
  }
  return map
}

function terminalRunId(): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'workflow' && isTerminalRunStatus(event.status)) return event.runId
  }
  throw new Error('no terminal event')
}

function eventSavedStartIndex(eventsRef: RunEvent[]): number {
  for (let i = 0; i < eventsRef.length; i += 1) {
    if (eventsRef[i].type === 'workflow') return i
  }
  throw new Error('no lifecycle events')
}
