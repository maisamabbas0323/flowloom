import type { WorkflowNode, PaperInstrumentsConfig } from '../../../shared/nodeSchema'
import { runPaperOperation, type PaperRunResult } from './paperRunner'
import { ExecutorError, type Executor, type ExecutorContext, type ExecutorResult } from './executors'
import type { FetchLike } from '../../providers/types'
import type { PaperGenerationMeta } from '../../../shared/runTypes'
import type { Logger } from '../../lib/log'

/**
 * The Paper Instruments executor: adapts the shared executor contract to
 * the real Ultramarine generation. Credentials are resolved through the
 * injected resolver at execution time (never embedded in the workflow,
 * never placed on outputs) and every failure — unconfigured, disabled,
 * refused by the spending stop, provider error, cancellation — becomes
 * an honest `ExecutorError`.
 */
export interface PaperExecutorDeps {
  /** Injectable for unit tests; real fetch in the app. */
  fetch: FetchLike
  logger: Logger
  credentials(): { apiKey: string } | null
  /** The model id configured in Settings / .env (fallback for nodes). */
  effectiveModel(): string
  /**
   * The Paper Instruments enable switch: false refuses every run
   * without a network request. Default is on.
   */
  enabled(): boolean
  /** Local prepaid-balance stop in dollars; 0 disables the check. */
  minBalanceUsd(): number
}

export function makePaperExecutor(deps: PaperExecutorDeps): Executor {
  return async (_node: WorkflowNode, ctx: ExecutorContext): Promise<ExecutorResult> => {
    if (ctx.signal.cancelled) throw new ExecutorError('Blocked: cancelled before the step started.')

    if (!deps.enabled()) {
      throw new ExecutorError(
        'Paper Instruments is switched off in Settings — turn it on there (it makes billable model calls) or remove this step.'
      )
    }

    const credentials = deps.credentials()
    if (!credentials) {
      throw new ExecutorError(
        'Paper Instruments credentials are missing — add the API key in Settings (or via PAPERINSTRUMENTS_API_KEY).'
      )
    }

    const config = ctx.config as Partial<PaperInstrumentsConfig>
    const model = (typeof config['model'] === 'string' ? config['model'].trim() : '') || deps.effectiveModel()
    if (model === '') {
      throw new ExecutorError(
        'No model ID is configured — enter one on this step, or set it in Settings / PAPERINSTRUMENTS_MODEL. Flowloom never guesses a model name.'
      )
    }

    const upstreamValues = new Map<string, string>()
    for (const [nodeId, output] of ctx.upstream) upstreamValues.set(nodeId, output.value)

    const result = await runPaperOperation(
      {
        config: ctx.config as PaperInstrumentsConfig,
        model,
        balanceStopUsd: deps.minBalanceUsd(),
        upstreamValues,
        signal: ctx.signal,
        onLog: (message) => ctx.onLog?.(message)
      },
      { fetch: deps.fetch, credentials }
    )

    return {
      value: result.value,
      meta: toMeta(result, model)
    }
  }
}

function toMeta(result: PaperRunResult, model: string): PaperGenerationMeta {
  return {
    model,
    finishReason: result.finishReason,
    truncated: result.truncated,
    structuredOutput: result.structured,
    promptTokens: result.usage?.promptTokens ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
    reasoningTokens: result.usage?.reasoningTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null,
    durationMs: result.durationMs,
    balanceAvailableUsd: result.balanceAvailableUsd
  }
}
