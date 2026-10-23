import { resolveTemplate, type PaperInstrumentsConfig } from '../../../shared/nodeSchema'
import { ExecutorError, type CancellationSignal } from './executors'
import {
  generatePaperCompletion,
  fetchPaperBalance,
  formatNanodollars,
  type PaperTokenUsage
} from '../../providers/paperinstruments'
import type { FetchLike } from '../../providers/types'

/**
 * The real Paper Instruments operation runner. Drives one generation:
 * resolves `{{stepId}}` templates against real upstream outputs, honors
 * the local prepaid-balance spending stop, sends ONE documented
 * chat-completions request, validates optional structured output, and
 * cancels through the run signal. The model id, credentials, and
 * everything secret stay out of node outputs — only the answer, its
 * truncation flag, and the provider's own usage numbers travel on.
 */

/** Ceiling for the text flowing downstream (matches template payload bounds). */
export const PAPER_OUTPUT_LIMIT = 64_000

export interface PaperRunRequest {
  config: PaperInstrumentsConfig
  /** Resolved generation model id (never empty: the executor checked). */
  model: string
  /** Local spending stop; 0 disables the pre-call balance check. */
  balanceStopUsd: number
  upstreamValues: Map<string, string>
  signal: CancellationSignal
  onLog?: (message: string) => void
}

export interface PaperRunDeps {
  fetch: FetchLike
  credentials: { apiKey: string }
}

export interface PaperRunResult {
  value: string
  truncated: boolean
  finishReason: string | null
  structured: boolean
  usage: PaperTokenUsage | null
  durationMs: number
  /** The balance the provider reported before the call, when checked. */
  balanceAvailableUsd: number | null
}

export async function runPaperOperation(
  request: PaperRunRequest,
  deps: PaperRunDeps
): Promise<PaperRunResult> {
  if (request.signal.cancelled) {
    throw new ExecutorError('Run was cancelled before the request started.')
  }

  const { config } = request

  // Real upstream values flow into the prompt through the same
  // {{stepId}} mechanism every other text field uses. Unresolved
  // references fail loudly — text is never silently dropped.
  const systemResolved = resolveTemplate(config.system, request.upstreamValues)
  if (!systemResolved.ok) throw new ExecutorError(systemResolved.error)
  const promptResolved = resolveTemplate(config.prompt, request.upstreamValues)
  if (!promptResolved.ok) throw new ExecutorError(promptResolved.error)
  if (promptResolved.value.trim() === '') {
    throw new ExecutorError('The prompt of this step is empty — nothing was sent to the model.')
  }

  // Cooperative cancellation → a real AbortSignal for the HTTP call.
  const abort = new AbortController()
  const onCancel = (): void => abort.abort()
  if (request.signal.cancelled) onCancel()
  else request.signal.listeners.add(onCancel)

  let balanceAvailableUsd: number | null = null
  try {
    // Local spending stop: read the prepaid balance the provider
    // reports (a documented free GET) and refuse below the floor.
    // This is a courtesy check — the provider itself reserves request
    // cost and returns 429 insufficient_quota when funds cannot cover
    // the reservation. A local check can never overrule that.
    if (request.balanceStopUsd > 0) {
      const balance = await fetchPaperBalance(
        { fetch: deps.fetch, timeoutMs: 15_000 },
        deps.credentials.apiKey
      )
      if ('availableNanodollars' in balance && typeof balance.availableNanodollars === 'number') {
        const availableUsd = balance.availableNanodollars / 1e9
        balanceAvailableUsd = Math.round(availableUsd * 100) / 100
        if (balanceAvailableUsd < request.balanceStopUsd) {
          throw new ExecutorError(
            `The prepaid balance (${formatNanodollars(balance.availableNanodollars)}) is below the configured stop of $${request.balanceStopUsd.toFixed(2)} — this step did not run, so no request was sent.`
          )
        }
      } else {
        throw new ExecutorError(
          'The prepaid balance could not be read before this request, so the generation was not started. Set the spending stop to $0.00 in Settings to skip the check, or try again when the Paper Instruments API answers.'
        )
      }
    }

    request.onLog?.(`Sending one ${config.reasoningEffort}-effort request to ${request.model}…`)
    const outcome = await generatePaperCompletion(
      { fetch: deps.fetch, timeoutMs: config.timeoutSeconds * 1000 },
      deps.credentials,
      {
        model: request.model,
        ...(systemResolved.value.trim() === '' ? {} : { system: systemResolved.value }),
        prompt: promptResolved.value,
        maxCompletionTokens: config.maxOutputTokens,
        reasoningEffort: config.reasoningEffort,
        jsonMode: (config.responseSchema ?? '').trim() !== '',
        externalSignal: abort.signal
      }
    )

    if (request.signal.cancelled) {
      // A cancel that raced the response still wins — the run is
      // reported cancelled, never as a success that "arrived anyway".
      throw new ExecutorError('Cancelled.')
    }
    if (!outcome.ok) {
      if (outcome.hint) request.onLog?.(`Provider detail: ${outcome.hint}`)
      throw new ExecutorError(outcome.message)
    }

    let value = outcome.content
    let truncated = outcome.finishReason === 'length'
    if (outcome.finishReason === 'length') {
      request.onLog?.('The reply reached its token limit — the text below is partial, not invented.')
    }
    if (value.length > PAPER_OUTPUT_LIMIT) {
      value = value.slice(0, PAPER_OUTPUT_LIMIT)
      truncated = true
      request.onLog?.(`The reply was longer than ${PAPER_OUTPUT_LIMIT} characters and was cut — only real content is kept.`)
    }

    const structured = (config.responseSchema ?? '').trim() !== ''
    if (structured) {
      const parsedSchema = JSON.parse(config.responseSchema) as unknown
      let document: unknown
      try {
        document = JSON.parse(value)
      } catch {
        throw new ExecutorError(
          'The structured reply was not valid JSON. The real response was kept in the step log, and the step is reported as failed — nothing downstream depends on it.'
        )
      }
      const check = validateJsonDocument(document, parsedSchema)
      if (!check.ok) {
        throw new ExecutorError(`The structured reply does not satisfy the configured schema: ${check.error}`)
      }
      // Downstream nodes receive the validated JSON document itself.
      value = JSON.stringify(document)
    }

    return {
      value,
      truncated,
      finishReason: outcome.finishReason,
      structured,
      usage: outcome.usage,
      durationMs: outcome.durationMs,
      balanceAvailableUsd
    }
  } finally {
    request.signal.listeners.delete(onCancel)
  }
}

/* ------------------------------------------------------------------ */
/* JSON Schema subset validation (honest, local, bounded)              */
/* ------------------------------------------------------------------ */

export type DocumentCheck = { ok: true } | { ok: false; error: string }

/**
 * Validates a parsed JSON document against a JSON Schema *subset*:
 * type, enum, string bounds (minLength/maxLength/pattern), numeric
 * bounds (minimum/maximum), array bounds (items/minItems/maxItems) and
 * object properties/required/additionalProperties. Unknown keywords are
 * ignored (a full draft validator is out of scope for a workflow node),
 * and this is honest enforcement of the subset only — the api's
 * `json_object` mode guarantees JSON, Flowloom guarantees this check.
 */
export function validateJsonDocument(value: unknown, schema: unknown, path = 'value'): DocumentCheck {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { ok: false, error: `the schema at "${path}" must be a JSON object` }
  }
  const schemaRecord = schema as Record<string, unknown>

  const allowedConst = schemaRecord['const']
  if (allowedConst !== undefined) {
    if (JSON.stringify(allowedConst) !== JSON.stringify(value)) {
      return { ok: false, error: `the value at "${path}" must equal the constant ${JSON.stringify(allowedConst)}` }
    }
  }
  const allowedEnum = schemaRecord['enum']
  if (Array.isArray(allowedEnum) && !allowedEnum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    return { ok: false, error: `the value at "${path}" is none of the enumerated values (${allowedEnum.map((entry) => JSON.stringify(entry)).join(', ')})` }
  }

  const expectedTypes = Array.isArray(schemaRecord['type'])
    ? (schemaRecord['type'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : typeof schemaRecord['type'] === 'string'
      ? [schemaRecord['type'] as string]
      : null
  if (expectedTypes && !jsonTypeMatches(value, expectedTypes)) {
    return { ok: false, error: `the value at "${path}" should be ${expectedTypes.join(' or ')} (${jsonTypeOf(value)} was returned)` }
  }

  return (
    checkStringBounds(value, schemaRecord, path) ??
    checkNumberBounds(value, schemaRecord, path) ??
    checkArrayShape(value, schemaRecord, path) ??
    checkObjectShape(value, schemaRecord, path) ?? { ok: true }
  )
}

type SubCheck = DocumentCheck | null

function checkStringBounds(value: unknown, schema: Record<string, unknown>, path: string): SubCheck {
  if (typeof value !== 'string') return null
  const minLength = typeof schema['minLength'] === 'number' ? schema['minLength'] : null
  const maxLength = typeof schema['maxLength'] === 'number' ? schema['maxLength'] : null
  if ((minLength !== null && value.length < minLength) || (maxLength !== null && value.length > maxLength)) {
    return { ok: false, error: `the text at "${path}" must be between ${String(minLength ?? 0)} and ${String(maxLength ?? 'unbounded')} characters` }
  }
  const pattern = typeof schema['pattern'] === 'string' ? schema['pattern'] : null
  if (pattern !== null) {
    try {
      if (new RegExp(pattern).test(value) === false) {
        return { ok: false, error: `the text at "${path}" does not match the required pattern` }
      }
    } catch {
      return { ok: false, error: `the pattern at "${path}" is not a valid regular expression` }
    }
  }
  return null
}

function checkNumberBounds(value: unknown, schema: Record<string, unknown>, path: string): SubCheck {
  if (typeof value !== 'number') return null
  const minimum = typeof schema['minimum'] === 'number' ? schema['minimum'] : null
  const maximum = typeof schema['maximum'] === 'number' ? schema['maximum'] : null
  if (minimum !== null && value < minimum) {
    return { ok: false, error: `the number at "${path}" is below ${String(minimum)}` }
  }
  if (maximum !== null && value > maximum) {
    return { ok: false, error: `the number at "${path}" is above ${String(maximum)}` }
  }
  return null
}

function checkArrayShape(value: unknown, schema: Record<string, unknown>, path: string): SubCheck {
  if (!Array.isArray(value)) return null
  const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : null
  const maxItems = typeof schema['maxItems'] === 'number' ? schema['maxItems'] : null
  if ((minItems !== null && value.length < minItems) || (maxItems !== null && value.length > maxItems)) {
    return { ok: false, error: `the list at "${path}" must hold between ${String(minItems ?? 0)} and ${String(maxItems ?? 'unbounded')} items` }
  }
  if (schema['items'] !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const check = validateJsonDocument(value[index], schema['items'], `${path}[${index}]`)
      if (!check.ok) return check
    }
  }
  return null
}

function checkObjectShape(value: unknown, schema: Record<string, unknown>, path: string): SubCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const properties = typeof schema['properties'] === 'object' && schema['properties'] !== null
    ? (schema['properties'] as Record<string, unknown>)
    : null
  if (Array.isArray(schema['required'])) {
    for (const field of schema['required'] as unknown[]) {
      if (typeof field !== 'string' || typeof value !== 'object' || value === null || Array.isArray(value)) continue
      if (!(field in value)) {
        return { ok: false, error: `the required field "${field}" is missing at "${path}"` }
      }
    }
  }
  if (properties) {
    for (const [field, subSchema] of Object.entries(properties)) {
      if (field in value) {
        const check = validateJsonDocument((value as Record<string, unknown>)[field], subSchema, `${path}.${field}`)
        if (!check.ok) return check
      }
    }
  }
  if (schema['additionalProperties'] === false && properties) {
    for (const field of Object.keys(value as Record<string, unknown>)) {
      if (!(field in properties)) {
        return { ok: false, error: `"${field}" at "${path}" is not in the schema (additional fields are not allowed)` }
      }
    }
  }
  return null
}

function jsonTypeMatches(value: unknown, types: string[]): boolean {
  const actual = jsonTypeOf(value)
  return types.some((type) => (type === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === type))
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
