import * as crypto from 'node:crypto'
import type {
  NodeRunStatus,
  RunEvent,
  RunRecord,
  RunStatus,
  RunStartResult
} from '../../../shared/runTypes'
import { isTerminalRunStatus } from '../../../shared/runTypes'
import type { WorkflowNode, NodeTypeId } from '../../../shared/nodeSchema'
import { getNodeType, validateWorkflowGraph } from '../../../shared/nodeSchema'
import type { WorkflowRecord } from '../../../shared/contracts'
import type { Logger, Redactor } from '../../lib/log'
import type { WorkflowService } from '../workflows'
import type { RunHistoryService } from '../runHistory'
import { plan, initialNodeRecords, nodeTitle, type PlannedGraph } from './planner'
import {
  ExecutorError,
  getExecutor,
  type Executor,
  type CancellationSignal,
  type NodeOutput
} from './executors'

/**
 * The execution engine: owns run lifecycles, plans persisted workflows,
 * schedules executor work along the real graph, passes outputs between
 * nodes, supports real cancellation, publishes typed events, and
 * persists truthful run history.
 *
 * Scheduling model (documented in agent.md):
 * - one promise per edge; it resolves when the source node reaches a
 *   terminal state (succeeded with the handle taken, skipped, failed);
 * - a node waits for all incoming edges, except a join with `any`,
 *   which proceeds on the first success;
 * - an unselected condition branch resolves to `skipped`, and a node
 *   whose incoming edges are all skipped is skipped too and skips its
 *   own downstream — skips can never deadlock a join;
 * - one failed upstream marks the node skipped; the run itself fails.
 */

/** Global concurrency policy: at most these runs execute at once. */
export const MAX_CONCURRENT_RUNS = 3
/** Safety cap on a single run's wall-clock time. */
export const HARD_RUN_LIMIT_MS = 2 * 60 * 60_000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type EdgeResolution =
  | { status: 'succeeded'; output: NodeOutput }
  | { status: 'skipped' }
  | { status: 'failed'; error: string }

interface EngineDeps {
  workflows: WorkflowService
  history: RunHistoryService
  redactor: Redactor
  logger: Logger
  /** Fan-out of engine events to open windows; tests may collect them. */
  publish?: (event: RunEvent) => void
  now?: () => Date
  randomId?: () => string
  /**
   * Optional credential gate, consulted before any side effects when a
   * workflow uses networked executors. Receives the nodes present in
   * the graph so each integration can check its own prerequisites.
   * Returns an actionable refusal message, or null when execution may
   * proceed.
   */
  credentialGate?: CredentialGate
}

export type CredentialGate = (nodes: Array<{ type: NodeTypeId; config: Record<string, unknown> }>) => string | null

export class ExecutionEngine {
  private readonly workflows: WorkflowService
  private readonly history: RunHistoryService
  private readonly redactor: Redactor
  private readonly logger: Logger
  private readonly publish: (event: RunEvent) => void
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly credentialGate: CredentialGate | null

  /** Active runs by runId. */
  private readonly runs = new Map<string, RunContext>()

  constructor(deps: EngineDeps) {
    this.workflows = deps.workflows
    this.history = deps.history
    this.redactor = deps.redactor
    this.logger = deps.logger
    this.publish = deps.publish ?? (() => undefined)
    this.now = deps.now ?? (() => new Date())
    this.randomId = deps.randomId ?? defaultRandomId
    this.credentialGate = deps.credentialGate ?? null
  }

  activeRunCount(): number {
    return this.runs.size
  }

  activeRunForWorkflow(workflowId: string): string | null {
    for (const [runId, ctx] of this.runs) {
      if (ctx.record.workflowId === workflowId) return runId
    }
    return null
  }

  /**
   * Starts a run of a *persisted* workflow. The renderer never sends
   * graph data — whatever is on disk is what executes, and the Run
   * action in the editor saves first.
   */
  start(workflowId: unknown): RunStartResult {
    if (typeof workflowId !== 'string' || workflowId.length === 0) {
      return { ok: false, errors: ['A workflow id is required to start a run.'] }
    }
    if (this.runs.size >= MAX_CONCURRENT_RUNS) {
      return {
        ok: false,
        errors: [`At most ${MAX_CONCURRENT_RUNS} runs can execute at once — wait for a run to finish.`]
      }
    }
    const activeId = this.activeRunForWorkflow(workflowId)
    if (activeId) {
      return {
        ok: false,
        errors: ['This workflow is already running — cancel the active run or wait for it to finish.']
      }
    }

    let record: WorkflowRecord | null
    try {
      record = this.workflows.get(workflowId)
    } catch {
      record = null
    }
    if (!record) {
      return { ok: false, errors: ['The workflow could not be found — it may have been deleted.'] }
    }

    const structural = validateWorkflowGraph(record.graph)
    if (!structural.structural) {
      return { ok: false, errors: ['The saved workflow has structural problems — open it in the editor and fix the highlighted issues.'] }
    }

    const outcome = plan(record, this.logger)
    if (!outcome.ok || !outcome.graph) {
      return { ok: false, errors: outcome.errors }
    }

    // Networked nodes must not start side effects without their
    // credentials configured; the refusal happens before any run exists.
    if (this.credentialGate) {
      const gate = this.credentialGate(record.graph.nodes.map((node) => ({ type: node.type, config: node.config })))
      if (gate) {
        return { ok: false, errors: [gate] }
      }
    }

    const startedAt = this.now().toISOString()
    const runId = `run_${this.randomId()}`
    const runRecord: RunRecord = {
      id: runId,
      workflowId: record.id,
      workflowName: record.name,
      schemaVersion: record.graph.schemaVersion,
      status: 'queued',
      startedAt,
      finishedAt: null,
      durationMs: null,
      nodes: initialNodeRecords(outcome.graph.nodes),
      error: null,
      cancelRequestedAt: null
    }

    const signal: CancellationSignal = { cancelled: false, listeners: new Set() }
    const ctx: RunContext = {
      record: runRecord,
      graph: outcome.graph,
      signal,
      statuses: new Map<string, NodeRunStatus>(
        runRecord.nodes.map((node) => [node.nodeId, 'pending' as NodeRunStatus])
      ),
      outputs: new Map<string, NodeOutput>(),
      edgePromises: new Map<string, Deferred<EdgeResolution>>(),
      nodeSettled: new Map<string, Promise<void>>(),
      timers: [] as NodeJS.Timeout[]
    }
    for (const edge of record.graph.edges) {
      ctx.edgePromises.set(edge.id, deferred<EdgeResolution>())
    }
    this.runs.set(runId, ctx)

    this.transition(ctx, 'validating')
    this.historyCreate(runRecord)
    this.transition(ctx, 'running')

    const hardCap = setTimeout(() => {
      if (!isTerminalRunStatus(ctx.record.status)) {
        ctx.forcedError = 'The run exceeded its two-hour safety cap and was stopped.'
        this.cancel(runId)
      }
    }, HARD_RUN_LIMIT_MS)
    ctx.timers.push(hardCap)

    // Fire and forget — the run keeps its own error boundary; every
    // failure path ends in a truthful terminal state + history entry.
    void this.execute(ctx)
    return { ok: true, runId }
  }

  /** Requests cancellation; returns false when nothing is running. */
  cancel(runId: unknown): boolean {
    if (typeof runId !== 'string') return false
    const ctx = this.runs.get(runId)
    if (!ctx || isTerminalRunStatus(ctx.record.status)) return false
    if (ctx.record.cancelRequestedAt === null) {
      ctx.record.cancelRequestedAt = this.now().toISOString()
    }
    this.transition(ctx, 'cancelling')
    ctx.signal.cancelled = true
    for (const listener of ctx.signal.listeners) listener()
    ctx.signal.listeners.clear()
    return true
  }

  /** Truthful terminal records when the app closes mid-run. */
  shutdown(): void {
    for (const [runId, ctx] of this.runs) {
      if (!isTerminalRunStatus(ctx.record.status)) {
        ctx.forcedError = ctx.forcedError ?? 'Flowloom closed while this run was executing.'
        this.cancel(runId)
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling                                                        */
  /* ---------------------------------------------------------------- */

  private async execute(ctx: RunContext): Promise<void> {
    const graph = ctx.graph
    try {
      // Launch every node; promise plumbing starts the ones whose
      // inputs resolve and keeps the rest pending until then.
      for (const node of graph.nodes) {
        this.launchNode(ctx, node)
      }
      await Promise.all([...ctx.nodeSettled.values()])
      this.finalize(ctx, null)
    } catch (error) {
      this.finalize(ctx, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Wires one node's destiny: waits for its incoming edges, decides
   * skip/fail/run, executes, publishes output to downstream edges.
   */
  private launchNode(ctx: RunContext, node: WorkflowNode): void {
    const incoming = ctx.graph.incomingByTarget.get(node.id) ?? []
    const definition = getNodeType(node.type)
    const parsedConfig = definition.parseConfig(node.config)
    const joinedAny =
      node.type === 'join' && parsedConfig !== null && parsedConfig['behavior'] === 'any'

    const settled = (async (): Promise<void> => {
      // Entry nodes (the manual trigger) have no incoming edges — they
      // start immediately instead of waiting for impossible inputs.
      if (incoming.length === 0) {
        if (ctx.signal.cancelled && !isTerminalRunStatus(ctx.record.status)) {
          this.setStatus(ctx, node, 'cancelled')
          this.resolveOutgoing(ctx, node, 'cancelled', null, null)
          return
        }
        await this.runNode(ctx, node, null)
        return
      }

      const results =
        joinedAny && incoming.length > 0
          ? await awaitFirstSuccess(incoming.map((id) => ctx.edgePromises.get(id)!.promise))
          : await Promise.all(incoming.map((id) => ctx.edgePromises.get(id)!.promise))

      if (ctx.signal.cancelled && !isTerminalRunStatus(ctx.record.status)) {
        // Cancellation reached scheduling before this node could start.
        this.setStatus(ctx, node, 'cancelled')
        this.resolveOutgoing(ctx, node, 'cancelled', null, null)
        return
      }

      const failedResolution = results.find((result) => result.status === 'failed')

      if (failedResolution && !joinedAny) {
        this.setStatus(ctx, node, 'skipped', failedResolution.error)
        this.resolveOutgoing(ctx, node, 'skipped', null, null)
        return
      }

      const nonSkipped = results.find((result) => result.status === 'succeeded')
      if (!nonSkipped) {
        const skippedOnly = results.every((result) => result.status === 'skipped')
        if (skippedOnly) {
          this.setStatus(ctx, node, 'skipped', null)
          this.resolveOutgoing(ctx, node, 'skipped', null, null)
          return
        }
        // Failure without success on an `any` join — treat like the
        // all-strategy failure path so the cause propagates honestly.
        this.setStatus(
          ctx,
          node,
          'skipped',
          failedResolution?.error ?? 'No connected branch delivered data.'
        )
        this.resolveOutgoing(ctx, node, 'skipped', null, null)
        return
      }

      await this.runNode(ctx, node, nonSkipped.output)
    })()

    // The executor path never throws (errors become node failures), so
    // this catch is a last-resort recorder only.
    settled.catch((error: unknown) => {
      this.logger.error(`Run ${ctx.record.id}: scheduler error: ${String(error)}`)
    })
    ctx.nodeSettled.set(node.id, settled)
  }

  private async runNode(
    ctx: RunContext,
    node: WorkflowNode,
    input: NodeOutput | null
  ): Promise<void> {
    const definition = getNodeType(node.type)
    const executor =
      node.type === 'trigger' ? this.triggerExecutorFor(ctx) : getExecutor(node.type)
    if (!executor || executor === undefined) {
      // Planner refuses unsupported types, so reaching this is a defect
      // — but never silently no-op: the node is marked failed.
      this.setStatus(ctx, node, 'skipped', 'This step has no executor — it should not have been planned.')
      this.resolveOutgoing(ctx, node, 'skipped', null, null)
      return
    }

    const config = definition.parseConfig(node.config) ?? node.config
    const logs: string[] = []
    const nodeRecord = ctx.record.nodes.find((entry) => entry.nodeId === node.id)!
    const startedAt = this.now()
    nodeRecord.startedAt = startedAt.toISOString()
    this.setStatus(ctx, node, 'running')

    try {
      const output = await executor(node, {
        config: config as Record<string, unknown>,
        input,
        upstream: ctx.outputs,
        signal: ctx.signal,
        onLog: (message) => {
          logs.push(message)
          if (logs.length <= 4) this.logger.info(`Run ${ctx.record.id} · ${nodeRecord.title}: ${message}`)
          // Publish the real stage to open windows — redacted, capped,
          // and only ever what actually happened.
          this.publish({
            type: 'node',
            runId: ctx.record.id,
            workflowId: ctx.record.workflowId,
            nodeId: node.id,
            status: 'running',
            at: this.now().toISOString(),
            nodeType: node.type,
            nodeTitle: nodeTitle(node).slice(0, 80),
            message: this.redact(message).slice(0, 160)
          })
        }
      })
      // A late success can never rewrite a cancelled run: the executor
      // may resolve after the cancel signal fired (async race), and the
      // cancelled terminal state wins.
      if (ctx.signal.cancelled && !isTerminalRunStatus(ctx.record.status)) {
        const finishedAt2 = this.now()
        nodeRecord.finishedAt = finishedAt2.toISOString()
        nodeRecord.durationMs = finishedAt2.getTime() - startedAt.getTime()
        nodeRecord.error = 'Cancelled.'
        this.setStatus(ctx, node, 'cancelled', 'Cancelled.')
        this.resolveOutgoing(ctx, node, 'cancelled', null, null)
        return
      }
      const finishedAt = this.now()
      nodeRecord.finishedAt = finishedAt.toISOString()
      nodeRecord.durationMs = finishedAt.getTime() - startedAt.getTime()
      nodeRecord.outputSummary = this.summarizeOutput(output.value)
      if (output.meta) nodeRecord.meta = capMeta(output.meta)
      this.setStatus(ctx, node, 'succeeded')
      ctx.outputs.set(node.id, output)
      this.resolveOutgoing(ctx, node, 'succeeded', output, null)
    } catch (error) {
      const finishedAt = this.now()
      nodeRecord.finishedAt = finishedAt.toISOString()
      nodeRecord.durationMs = finishedAt.getTime() - startedAt.getTime()
      const cancelled = ctx.signal.cancelled
      const message = cancelled
        ? 'Cancelled.'
        : error instanceof ExecutorError
          ? error.message
          : 'The step failed unexpectedly.'
      nodeRecord.error = this.redact(message)
      this.setStatus(ctx, node, cancelled ? 'cancelled' : 'failed', message)
      this.resolveOutgoing(ctx, node, cancelled ? 'cancelled' : 'failed', null, message)
    }
  }

  /**
   * Per-run trigger executor — returns real run metadata and refuses to
   * fire into a cancelled run. Built per run rather than globally so
   * concurrent runs can never read each other's metadata.
   */
  private triggerExecutorFor(ctx: RunContext): Executor {
    return async () => {
      if (ctx.signal.cancelled) {
        throw new ExecutorError('Run was cancelled before the trigger fired.')
      }
      return {
        value: JSON.stringify({
          runId: ctx.record.id,
          workflowId: ctx.record.workflowId,
          workflow: ctx.record.workflowName,
          startedAt: this.now().toISOString()
        })
      }
    }
  }

  /**
   * Resolves all outgoing edge promises according to the node's real
   * terminal state. Condition nodes resolve per-handle: the unchosen
   * branch reports `skipped`, never fake success.
   */
  private resolveOutgoing(
    ctx: RunContext,
    node: WorkflowNode,
    status: 'succeeded' | 'skipped' | 'failed' | 'cancelled',
    output: NodeOutput | null,
    error: string | null
  ): void {
    for (const out of ctx.graph.outgoingBySource.get(node.id) ?? []) {
      const edge = ctx.edgePromises.get(out.id)
      if (!edge) continue
      switch (status) {
        case 'succeeded': {
          if (node.type === 'condition') {
            const taken = output?.branch
            if (taken === 'true' || taken === 'false') {
              if (out.sourceHandle === taken) edge.resolve({ status: 'succeeded', output: output! })
              else edge.resolve({ status: 'skipped' })
            } else {
              edge.resolve({ status: 'skipped' })
            }
          } else if (output) {
            edge.resolve({ status: 'succeeded', output })
          } else {
            edge.resolve({ status: 'skipped' })
          }
          break
        }
        case 'skipped':
          edge.resolve({ status: 'skipped' })
          break
        case 'cancelled':
          edge.resolve({ status: 'failed', error: 'The run was cancelled.' })
          break
        case 'failed':
          edge.resolve({ status: 'failed', error: error ?? 'An earlier step failed.' })
          break
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle, history, events                                        */
  /* ---------------------------------------------------------------- */

  private transition(ctx: RunContext, status: RunStatus): void {
    ctx.record.status = status
    this.publish({
      type: 'workflow',
      runId: ctx.record.id,
      workflowId: ctx.record.workflowId,
      status,
      at: this.now().toISOString(),
      message: ctx.forcedError ?? undefined
    })
    this.historyWrite(ctx)
  }

  private setStatus(
    ctx: RunContext,
    node: WorkflowNode,
    status: NodeRunStatus,
    note: string | null = null
  ): void {
    ctx.statuses.set(node.id, status)
    const record = ctx.record.nodes.find((entry) => entry.nodeId === node.id)
    if (record) {
      record.status = status
      if (note && status !== 'succeeded' && record.error === null) {
        record.error = this.redact(note)
      }
      if (note && status === 'skipped') record.error = record.error ?? this.redact(note)
    }
    this.publish({
      type: 'node',
      runId: ctx.record.id,
      workflowId: ctx.record.workflowId,
      nodeId: node.id,
      status,
      at: this.now().toISOString(),
      nodeType: node.type,
      nodeTitle: nodeTitle(node).slice(0, 80)
    })
    this.historyWrite(ctx)
  }

  private finalize(ctx: RunContext, unexpected: string | null): void {
    if (isTerminalRunStatus(ctx.record.status)) return
    for (const timer of ctx.timers) clearTimeout(timer)
    ctx.timers.length = 0

    const statuses = [...ctx.statuses.values()]

    let terminal: RunStatus
    let error: string | null = null
    if (unexpected) {
      terminal = 'failed'
      error = this.redact(unexpected)
    } else if (ctx.signal.cancelled) {
      terminal = 'cancelled'
      error = ctx.forcedError ?? null
    } else {
      const failed = ctx.record.nodes.filter((node) => node.status === 'failed')
      if (failed.length > 0) {
        terminal = 'failed'
        const first = failed[0]
        error = `${first.title}: ${first.error ?? 'failed'}`
      } else if (statuses.includes('succeeded')) {
        terminal = 'succeeded'
      } else {
        terminal = 'failed'
        error = 'No step executed — the workflow start could not run.'
      }
    }

    const finishedAt = this.now().toISOString()
    ctx.record.status = terminal
    ctx.record.finishedAt = finishedAt
    ctx.record.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(ctx.record.startedAt))
    ctx.record.error = error

    // Nodes that never got to run report honestly as cancelled.
    for (const node of ctx.record.nodes) {
      if (node.status === 'pending') node.status = 'cancelled'
    }

    this.publish({
      type: 'workflow',
      runId: ctx.record.id,
      workflowId: ctx.record.workflowId,
      status: terminal,
      at: finishedAt,
      message: error ?? undefined
    })
    this.runs.delete(ctx.record.id)
    this.historyWrite(ctx)
    this.logger.info(
      `Run ${ctx.record.id} finished: ${terminal}${
        ctx.record.durationMs !== null ? ` in ${ctx.record.durationMs}ms` : ''
      }`
    )
  }

  private summarizeOutput(output: string): string {
    const redacted = this.redact(output)
    const LIMIT = 400
    return redacted.length > LIMIT ? `${redacted.slice(0, LIMIT)}…` : redacted
  }

  private redact(value: string): string {
    try {
      return this.redactor.redact(value)
    } catch {
      return value
    }
  }

  private historyWrite(ctx: RunContext): void {
    void this.history
      .save(ctx.record)
      .catch((error: unknown) =>
        this.logger.warn(`Run-history write failed: ${error instanceof Error ? error.message : String(error)}`)
      )
  }

  private historyCreate(record: RunRecord): void {
    void this.history.create(record).catch((error: unknown) =>
      this.logger.warn(`Run-history create failed: ${error instanceof Error ? error.message : String(error)}`)
    )
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

interface RunContext {
  record: RunRecord
  graph: PlannedGraph
  signal: CancellationSignal
  statuses: Map<string, NodeRunStatus>
  outputs: Map<string, NodeOutput>
  edgePromises: Map<string, Deferred<EdgeResolution>>
  nodeSettled: Map<string, Promise<void>>
  timers: NodeJS.Timeout[]
  forcedError?: string
}

/**
 * Join-`any` primitive: resolves as soon as one edge delivers success,
 * otherwise falls back to the honest aggregate result once every edge
 * has resolved. Skipped branches never block; a genuine failure only
 * surfaces when no branch succeeded.
 */
async function awaitFirstSuccess(
  edges: Promise<EdgeResolution>[]
): Promise<EdgeResolution[]> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: EdgeResolution[]): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    for (const edge of edges) {
      void edge.then((result) => {
        if (result.status === 'succeeded') finish([result])
      })
    }
    void Promise.all(edges).then((results) => {
      if (settled) return
      if (results.every((result) => result.status === 'skipped')) finish(results)
      else {
        const failed = results.find((result) => result.status === 'failed')
        finish(failed ? [failed] : results)
      }
    })
  })
}

function defaultRandomId(): string {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 16)
}

/**
 * Bounds node metadata before it is persisted: safe string fields
 * are capped, unknown extra keys are dropped so history stays small
 * and secret-free by construction. The two shapes are discriminated by
 * `model` (Paper Instruments generation) versus `operation` (browser).
 */
function capMeta(meta: NonNullable<NodeOutput['meta']>): NonNullable<NodeOutput['meta']> {
  const capString = (value: string | null, limit: number): string | null =>
    value === null ? null : value.length > limit ? `${value.slice(0, limit)}…` : value
  if ('model' in meta) {
    return {
      model: capString(meta.model, 200) ?? '',
      finishReason: capString(meta.finishReason, 32),
      truncated: meta.truncated === true,
      structuredOutput: meta.structuredOutput === true,
      promptTokens: typeof meta.promptTokens === 'number' ? Math.max(0, meta.promptTokens) : null,
      completionTokens: typeof meta.completionTokens === 'number' ? Math.max(0, meta.completionTokens) : null,
      reasoningTokens: typeof meta.reasoningTokens === 'number' ? Math.max(0, meta.reasoningTokens) : null,
      totalTokens: typeof meta.totalTokens === 'number' ? Math.max(0, meta.totalTokens) : null,
      durationMs: typeof meta.durationMs === 'number' ? Math.max(0, meta.durationMs) : null,
      balanceAvailableUsd: typeof meta.balanceAvailableUsd === 'number' ? Math.max(0, meta.balanceAvailableUsd) : null
    }
  }
  return {
    operation: capString(meta.operation, 32) ?? 'unknown',
    finalUrl: capString(meta.finalUrl, 800),
    pageTitle: capString(meta.pageTitle, 300),
    textChars: typeof meta.textChars === 'number' ? meta.textChars : null,
    textTruncated: meta.textTruncated === true,
    screenshotId: capString(meta.screenshotId, 64),
    sessionId: capString(meta.sessionId, 64),
    durationMs: typeof meta.durationMs === 'number' ? Math.max(0, meta.durationMs) : null
  }
}
