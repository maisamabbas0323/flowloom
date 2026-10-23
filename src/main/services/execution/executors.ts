import type { BrowserOperationMeta, PaperGenerationMeta } from '../../../shared/runTypes'
import {
  conditionConfigSchema,
  dataConfigSchema,
  delayConfigSchema,
  joinConfigSchema,
  resolveTemplate,
  type ConditionOperator
} from '../../../shared/nodeSchema'
import type { WorkflowNode } from '../../../shared/nodeSchema'

/**
 * Explicit executor registry for Prompt 3. Every executable node type
 * has exactly one executor here; unknown or deferred types (browser
 * actions) never reach an executor because the planner refuses the run
 * first. Thinking happens on plain data — no eval, no Function, no
 * shell, and never any model call for a static value.
 */

/** The output each finished node publishes to its downstream edges. */
export interface NodeOutput {
  /** The value flowing downstream (may be empty for an empty data node). */
  value: string
  /**
   * Only set by condition nodes: which decision branch was taken so the
   * engine can resolve `true`/`false` outgoing edges honestly — the
   * unselected branch skips instead of pretending to succeed.
   */
  branch?: 'true' | 'false'
  /**
   * Structured, secret-free metadata published by browser-action and
   * Paper Instruments nodes. It is persisted with the run record
   * (bounded) so history and the renderer can show the real outcome.
   */
  meta?: BrowserOperationMeta | PaperGenerationMeta
}

/** Back-compat name for the browser metadata shape. */
export type BrowserActionMeta = BrowserOperationMeta

/** Cooperative cancellation carried by every executor context. */
export type CancellationSignal = {
  cancelled: boolean
  /** Set while waiting (delay executor); fired on cancel to abort promptly. */
  listeners: Set<() => void>
}

export interface ExecutorContext {
  /** Actual resolved configuration for this node instance. */
  config: Record<string, unknown>
  /** Output published by the primary upstream step (null for triggers). */
  input: NodeOutput | null
  /** Outputs of every node that has already finished in this run. */
  upstream: Map<string, NodeOutput>
  /** Cooperative cancellation flag checked by (async) executors. */
  signal: CancellationSignal
  onLog?: (message: string) => void
}

export type ExecutorResult = NodeOutput

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutorError'
  }
}

export type Executor = (node: WorkflowNode, ctx: ExecutorContext) => Promise<ExecutorResult>

/* ------------------------------------------------------------------ */
/* Manual trigger                                                      */
/* ------------------------------------------------------------------ */

interface TriggerInit {
  runId: string
  workflowId: string
  workflowName: string
}

export function makeTriggerExecutor(init: TriggerInit): Executor {
  return async (_node, ctx) => {
    if (ctx.signal.cancelled) throw new ExecutorError('Run was cancelled before the trigger fired.')
    return {
      value: JSON.stringify({
        runId: init.runId,
        workflowId: init.workflowId,
        workflow: init.workflowName,
        startedAt: new Date().toISOString()
      })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Data / text                                                         */
/* ------------------------------------------------------------------ */

export const dataExecutor: Executor = async (_node, ctx) => {
  const parsed = dataConfigSchema.safeParse(ctx.config)
  if (!parsed.success) throw new ExecutorError('The text value of this step is not configured.')
  const resolved = resolveTemplate(parsed.data.value, mapValues(ctx.upstream))
  if (!resolved.ok) throw new ExecutorError(resolved.error)
  return { value: resolved.value }
}

/* ------------------------------------------------------------------ */
/* Delay                                                               */
/* ------------------------------------------------------------------ */

/** One-second safety margin on top of the schema cap (3600s). */
export const MAX_DELAY_MS = 3600_000

export const delayExecutor: Executor = async (_node, ctx) => {
  const parsed = delayConfigSchema.safeParse(ctx.config)
  if (!parsed.success) {
    throw new ExecutorError('The delay must be between 1 and 3600 seconds — check the step configuration.')
  }
  const ms = Math.round(parsed.data.seconds * 1000)
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_DELAY_MS) {
    throw new ExecutorError(`The delay must be between 1 and 3600 seconds.`)
  }
  const started = Date.now()
  ctx.onLog?.(`Waiting ${parsed.data.seconds}s…`)
  await cancellableDelay(ms, ctx.signal)
  const waited = Date.now() - started
  // Honest accounting: real elapsed time, including cancellation slack.
  if (Math.abs(waited - ms) > 250) {
    ctx.onLog?.(`Wait finished early (${waited}ms instead of ${ms}ms) — the wait was interrupted.`)
  }
  return { value: `waited ${parsed.data.seconds}s` }
}

export function cancellableDelay(ms: number, signal: CancellationSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.cancelled) {
      reject(new ExecutorError('Wait cancelled.'))
      return
    }
    const timer = setTimeout(() => {
      signal.listeners.delete(onCancel)
      resolve()
    }, ms)
    const onCancel = (): void => {
      signal.listeners.delete(onCancel)
      clearTimeout(timer)
      reject(new ExecutorError('Wait cancelled.'))
    }
    signal.listeners.add(onCancel)
    if (signal.cancelled) onCancel()
  })
}

/* ------------------------------------------------------------------ */
/* Condition                                                           */
/* ------------------------------------------------------------------ */

export interface ConditionOutcome {
  taken: 'true' | 'false'
  reason: string
  output: string
}

/** Deterministic, type-aware comparison used by both engine and tests. */
export function evaluateCondition(
  checkText: string,
  operator: ConditionOperator,
  compareTo: string
): ConditionOutcome {
  switch (operator) {
    case 'contains':
      return checkText.includes(compareTo)
        ? { taken: 'true', reason: `"${checkText}" contains "${compareTo}"`, output: checkText }
        : { taken: 'false', reason: `"${checkText}" does not contain "${compareTo}"`, output: checkText }
    case 'doesNotContain':
      return checkText.includes(compareTo)
        ? { taken: 'false', reason: `"${checkText}" contains "${compareTo}"`, output: checkText }
        : { taken: 'true', reason: `"${checkText}" does not contain "${compareTo}"`, output: checkText }
    case 'equals':
      return checkText === compareTo
        ? { taken: 'true', reason: 'texts are equal', output: checkText }
        : { taken: 'false', reason: 'texts are not equal', output: checkText }
    case 'notEquals':
      return checkText !== compareTo
        ? { taken: 'true', reason: 'texts differ', output: checkText }
        : { taken: 'false', reason: 'texts are equal', output: checkText }
    case 'isEmpty':
      return checkText.length === 0
        ? { taken: 'true', reason: 'the text is empty', output: checkText }
        : { taken: 'false', reason: 'the text is not empty', output: checkText }
    case 'isNotEmpty':
      return checkText.length > 0
        ? { taken: 'true', reason: 'the text is not empty', output: checkText }
        : { taken: 'false', reason: 'the text is empty', output: checkText }
  }
}

export const conditionExecutor: Executor = async (_node, ctx) => {
  const parsed = conditionConfigSchema.safeParse(ctx.config)
  if (!parsed.success) throw new ExecutorError('The condition of this step is not configured.')
  const { operator } = parsed.data
  const checkTemplate = parsed.data.checkText ?? ''
  const compareTo = parsed.data.contains ?? ''

  const check = resolveTemplate(checkTemplate, mapValues(ctx.upstream))
  if (!check.ok) throw new ExecutorError(check.error)
  let compareValue = compareTo
  if (operator !== 'isEmpty' && operator !== 'isNotEmpty') {
    const compare = resolveTemplate(compareTo, mapValues(ctx.upstream))
    if (!compare.ok) throw new ExecutorError(compare.error)
    compareValue = compare.value
  }
  const outcome = evaluateCondition(check.value, operator, compareValue)
  ctx.onLog?.(`Condition: ${outcome.reason} → ${outcome.taken}`)
  return { value: outcome.output, branch: outcome.taken }
}

/* ------------------------------------------------------------------ */
/* Wait for connections (join)                                         */
/* ------------------------------------------------------------------ */

export const joinExecutor: Executor = async (_node, ctx) => {
  const parsed = joinConfigSchema.safeParse(ctx.config)
  if (!parsed.success) throw new ExecutorError('The join behavior of this step is not configured.')
  if (!ctx.input) {
    throw new ExecutorError('No connected branch delivered data to this join step.')
  }
  return { value: ctx.input.value }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export interface ExecutorEntry {
  execute: Executor
}

export function getExecutor(nodeType: string): Executor | null {
  const executor = executors[nodeType]
  // Trigger is registered per-run by the engine (it needs run metadata).
  if (nodeType === 'trigger') return executor
  return executor ?? null
}

const executors: Record<string, Executor> = {
  trigger: notRegistered,
  browserAction: notRegistered,
  paperInstruments: notRegistered,
  data: dataExecutor,
  delay: delayExecutor,
  condition: conditionExecutor,
  join: joinExecutor
}

async function notRegistered(): Promise<ExecutorResult> {
  throw new ExecutorError('This step has no executor registered for this run.')
}

export function setTriggerExecutor(executor: Executor): void {
  executors['trigger'] = executor
}

export function setBrowserExecutor(executor: Executor | null): void {
  executors['browserAction'] = executor ?? notRegistered
}

export function setPaperExecutor(executor: Executor | null): void {
  executors['paperInstruments'] = executor ?? notRegistered
}

/** Helper: adapt { value } outputs to the plain map resolveTemplate wants. */
function mapValues(map: Map<string, NodeOutput>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, output] of map) out.set(key, output.value)
  return out
}
