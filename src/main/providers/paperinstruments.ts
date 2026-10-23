import { request, extractProviderErrorText, networkFailure, HttpTestError } from './http'
import { failure, success, type ProviderContext, type ProviderTestResult } from './types'
import type { FailureCode } from '../../shared/contracts'

/**
 * Paper Instruments — the Ultramarine API (docs.paperinstruments.com).
 *
 * Verified upstream facts (October 2026 documentation):
 * - Base URL https://api.paperinstruments.com/v1, OpenAI-style
 *   `Authorization: Bearer <key>`; keys look like `pi_live_…`.
 * - `POST /v1/chat/completions` — OpenAI-compatible; `reasoning_effort`
 *   (`low|high|max`, default `max`), `max_completion_tokens` (positive
 *   integer incl. reasoning), optional `response_format: {"type": "json_object"}`.
 *   Streaming is optional; we use non-streaming (`stream: false`).
 * - Free verification endpoints: `GET /v1/models`, `GET /v1/models/{id}`,
 *   `GET /v1/usage` (org usage this month incl. `available_nanodollars`,
 *   1 USD = 1e9 nanodollars). None of these generate tokens.
 * - Documented error codes: 401 invalid_api_key/missing_api_key,
 *   403 billing_account_suspended, 404 model_not_found/resource_missing,
 *   429 insufficient_quota vs 429 rate_limit_exceeded /
 *   concurrency_limit_exceeded, 502/5xx family, 400 invalid_value with
 *   `error.param` naming the bad field.
 *
 * The API key is never placed in URLs or error text — only in the
 * Authorization header, which is redacted everywhere downstream.
 */

export const PAPER_INSTRUMENTS_BASE_URL = 'https://api.paperinstruments.com/v1'
export const PAPER_INSTRUMENTS_HOST = 'api.paperinstruments.com'

/** Documented quickstart model id, surfaced only as UI hints — never
 *  auto-substituted for a missing configuration. */
export const DOCUMENTED_EXAMPLE_MODEL = 'ultramarine-1-flash'

/* ------------------------------------------------------------------ */
/* Error mapping (documented status codes / envelope)                   */
/* ------------------------------------------------------------------ */

interface PaperErrorBody {
  code: string | null
  param: string | null
}

function readPaperErrorBody(bodyText: string): PaperErrorBody {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; param?: unknown } }
    const error = parsed?.error
    return {
      code: typeof error?.code === 'string' ? error.code : null,
      param: typeof error?.param === 'string' ? error.param : null
    }
  } catch {
    return { code: null, param: null }
  }
}

/**
 * Maps one HTTP error response to an honest Flowloom failure code using
 * the documented error table. `context` describes the request so
 * messages can name the model id when the provider named it as the
 * invalid field.
 */
export function mapPaperError(
  status: number,
  bodyText: string,
  context: { modelId?: string } = {}
): { code: FailureCode; message: string; hint?: string } {
  const { code, param } = readPaperErrorBody(bodyText)
  const hint = extractProviderErrorText(bodyText)
  if (status === 401) {
    return {
      code: 'auth',
      message: 'Paper Instruments rejected the API key (the account reports an invalid, expired, revoked, or wrong-environment key).'
    }
  }
  if (status === 403) {
    return {
      code: 'auth',
      message: code === 'billing_account_suspended'
        ? 'The Paper Instruments billing account is suspended — spend is blocked until the account is restored.'
        : 'Paper Instruments refused access to this account.'
    }
  }
  if (status === 404) {
    return {
      code: 'model_not_found',
      message: `Paper Instruments does not serve the model id "${context.modelId ?? ''}". Use the exact id your account lists (GET /v1/models).`,
      hint
    }
  }
  if (status === 429) {
    if (code === 'insufficient_quota') {
      return {
        code: 'insufficient_credit',
        message: 'The prepaid balance could not cover this request (429 insufficient_quota). Add funds in the Paper Instruments console or lower the output limit.'
      }
    }
    return {
      code: 'rate_limit',
      message: 'Paper Instruments rate-limited or concurrency-limited this request. Wait a moment and try again.'
    }
  }
  if (status === 400 || status === 422) {
    if (param === 'model') {
      return {
        code: 'model_not_found',
        message: `Paper Instruments rejected the model id "${context.modelId ?? ''}" as invalid (400 invalid_value). Use the exact id your account lists.`,
        hint
      }
    }
    return { code: 'unknown', message: 'Paper Instruments rejected the request as invalid.', hint }
  }
  if (status >= 500) {
    return { code: 'server_error', message: 'Paper Instruments reported a server-side problem. This is not a Flowloom failure.', hint }
  }
  return { code: 'unknown', message: `Paper Instruments returned an unexpected response (status ${status}).`, hint }
}

function mapNetwork(error: unknown): { code: FailureCode; message: string } {
  const mapped = networkFailure(error, PAPER_INSTRUMENTS_HOST)
  return { code: mapped.code, message: mapped.message }
}

/* ------------------------------------------------------------------ */
/* Free connection test (no tokens, no session, no spend)              */
/* ------------------------------------------------------------------ */

/** Org prepaid balance as reported by GET /v1/usage, in nanodollars. */
export interface PaperBalance {
  availableNanodollars: number | null
  reservedNanodollars: number | null
}

/**
 * Reads the documented usage endpoint. Returns numbers only when the
 * body actually carries numeric fields — nothing is invented when the
 * response cannot be parsed.
 */
export async function fetchPaperBalance(
  ctx: ProviderContext,
  apiKey: string
): Promise<PaperBalance | { code: FailureCode; message: string }> {
  try {
    const response = await request(ctx, {
      url: `${PAPER_INSTRUMENTS_BASE_URL}/usage`,
      method: 'GET',
      headers: authHeaders(apiKey)
    })
    if (response.status === 401 || response.status === 403) {
      return { code: 'auth', message: 'Paper Instruments rejected the API key while reading usage.' }
    }
    if (response.status !== 200) {
      const mapped = mapPaperError(response.status, response.bodyText)
      return { code: mapped.code, message: mapped.message }
    }
    try {
      const parsed = JSON.parse(response.bodyText) as {
        available_nanodollars?: unknown
        reserved_nanodollars?: unknown
      }
      return {
        availableNanodollars: typeof parsed.available_nanodollars === 'number' ? parsed.available_nanodollars : null,
        reservedNanodollars: typeof parsed.reserved_nanodollars === 'number' ? parsed.reserved_nanodollars : null
      }
    } catch {
      return { code: 'invalid_response', message: 'The usage response could not be parsed.' }
    }
  } catch (error) {
    return mapNetwork(error)
  }
}

/**
 * The Paper Instruments connection test — entirely free by design.
 * Verifies, in order: the API key (GET /v1/models), that the configured
 * model id exists for the account (GET /v1/models/{id}), and reads the
 * prepaid balance (GET /v1/usage) so the UI can show a real, current
 * figure instead of a fabricated one.
 */
export async function testPaperInstruments(
  ctx: ProviderContext,
  input: { apiKey: string; modelId: string }
): Promise<ProviderTestResult> {
  try {
    const listing = await request(ctx, {
      url: `${PAPER_INSTRUMENTS_BASE_URL}/models`,
      method: 'GET',
      headers: authHeaders(input.apiKey)
    })
    if (listing.status === 401 || listing.status === 403) {
      const mapped = mapPaperError(listing.status, listing.bodyText)
      return failure(mapped.code, mapped.message)
    }
    if (listing.status !== 200) {
      const mapped = mapPaperError(listing.status, listing.bodyText)
      return failure(mapped.code, mapped.message, mapped.hint)
    }

    const model = await request(ctx, {
      url: `${PAPER_INSTRUMENTS_BASE_URL}/models/${encodeURIComponent(input.modelId)}`,
      method: 'GET',
      headers: authHeaders(input.apiKey)
    })
    if (model.status === 404) {
      return failure('model_not_found', `Paper Instruments does not serve the model id "${input.modelId}". Check the exact id supplied by your account (the documented example is ${DOCUMENTED_EXAMPLE_MODEL}).`)
    }
    if (model.status === 401 || model.status === 403) {
      const mapped = mapPaperError(model.status, model.bodyText)
      return failure(mapped.code, mapped.message)
    }
    if (model.status !== 200) {
      const mapped = mapPaperError(model.status, model.bodyText)
      return failure(mapped.code, mapped.message, mapped.hint)
    }

    const balance = await fetchPaperBalance(ctx, input.apiKey)
    if ('code' in balance) {
      // The key and model verified; the balance read is not allowed to
      // turn this into a fake failure or a fake figure.
      return success(`Connected. Model "${input.modelId}" is available for this account. The prepaid balance could not be read (${balance.message}).`)
    }
    if (balance.availableNanodollars === null) {
      return success(`Connected. Model "${input.modelId}" is available for this account. The usage response did not include a balance figure.`)
    }
    const formatted = `Connected. Model "${input.modelId}" is available for this account. Prepaid balance available: ${formatNanodollars(balance.availableNanodollars)}${balance.reservedNanodollars !== null ? ` (reserved: ${formatNanodollars(balance.reservedNanodollars)})` : ''}.`
    return success(formatted)
  } catch (error) {
    if (error instanceof HttpTestError) {
      return failure('timeout', 'The Paper Instruments API did not answer in time — no connection claim is made.')
    }
    const mapped = mapNetwork(error)
    return failure(mapped.code, mapped.message)
  }
}

/** 1 USD = 1e9 nanodollars, per the billing docs. */
export function formatNanodollars(nanodollars: number): string {
  const dollars = nanodollars / 1e9
  const rounded = Math.round(dollars * 100) / 100
  return `$${rounded.toFixed(2)}`
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

/* ------------------------------------------------------------------ */
/* Real generation (billable — always user-initiated)                   */
/* ------------------------------------------------------------------ */

export interface PaperTokenUsage {
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
}

export type PaperGenerationResult =
  | {
      ok: true
      /** The model's real answer text (never fabricated here). */
      content: string
      finishReason: string | null
      usage: PaperTokenUsage | null
      durationMs: number
    }
  | { ok: false; code: FailureCode; message: string; hint?: string }

export interface PaperGenerationRequest {
  model: string
  /** Optional system instruction (documented `system` role). */
  system?: string
  /** The user prompt; `{{stepId}}` templates are resolved before this call. */
  prompt: string
  /** Positive integer, includes reasoning tokens (bounds the reservation). */
  maxCompletionTokens: number
  /** Documented values: low | high | max. */
  reasoningEffort: 'low' | 'high' | 'max'
  /** Requests `response_format: {"type": "json_object"}` (documented). */
  jsonMode?: boolean
  /**
   * Cooperative cancellation: aborted the moment it fires so half-made
   * requests stop charging. Interrupted requests still pay for tokens
   * produced so far — documented provider behaviour, never hidden.
   */
  externalSignal?: AbortSignal
}

interface ChoiceMessage {
  content?: unknown
}

interface CompletionBody {
  choices?: unknown
  usage?: {
    prompt_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown } | null
    completion_tokens?: unknown
    completion_tokens_details?: { reasoning_tokens?: unknown } | null
    total_tokens?: unknown
  } | null
}

function readUsage(usage: CompletionBody['usage']): PaperTokenUsage | null {
  if (!usage) return null
  const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    promptTokens: numberOrNull(typeof usage.prompt_tokens === 'string' ? Number(usage.prompt_tokens) : usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    reasoningTokens: numberOrNull(usage.completion_tokens_details?.reasoning_tokens),
    totalTokens: numberOrNull(usage.total_tokens)
  }
}

/**
 * Sends one real, non-streaming chat completion. No SDK — one fetch to
 * the documented endpoint, so the exact production request is testable.
 * Success requires an actual HTTP 200 with a parseable, OpenAI-shaped
 * body — never "the fields were filled in".
 */
export async function generatePaperCompletion(
  ctx: ProviderContext,
  credentials: { apiKey: string },
  requestInput: PaperGenerationRequest
): Promise<PaperGenerationResult> {
  const started = Date.now()
  const messages: Array<{ role: 'system' | 'user'; content: string }> = []
  if (requestInput.system && requestInput.system.trim() !== '') {
    messages.push({ role: 'system', content: requestInput.system })
  }
  messages.push({ role: 'user', content: requestInput.prompt })

  const body: Record<string, unknown> = {
    model: requestInput.model,
    messages,
    reasoning_effort: requestInput.reasoningEffort,
    max_completion_tokens: requestInput.maxCompletionTokens,
    stream: false
  }
  if (requestInput.jsonMode) {
    body['response_format'] = { type: 'json_object' }
  }

  try {
    const response = await request(ctx, {
      url: `${PAPER_INSTRUMENTS_BASE_URL}/chat/completions`,
      method: 'POST',
      headers: { ...authHeaders(credentials.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      externalSignal: requestInput.externalSignal
    })
    const durationMs = Date.now() - started
    if (response.status !== 200) {
      const mapped = mapPaperError(response.status, response.bodyText, { modelId: requestInput.model })
      return { ok: false, code: mapped.code, message: mapped.message, hint: mapped.hint }
    }
    let parsed: CompletionBody
    try {
      parsed = JSON.parse(response.bodyText) as CompletionBody
    } catch {
      return { ok: false, code: 'invalid_response', message: 'The Paper Instruments response was not readable JSON.' }
    }
    const choices = Array.isArray(parsed.choices) ? (parsed.choices as unknown[]) : null
    const first = choices && choices.length > 0 ? (choices[0] as { message?: ChoiceMessage; finish_reason?: unknown }) : null
    if (!first) {
      return { ok: false, code: 'invalid_response', message: 'The Paper Instruments response contained no completion choices.' }
    }
    const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : null
    const content = first.message?.content
    if (typeof content !== 'string') {
      // A null content with finish_reason "length" means the output
      // budget went to reasoning — real tokens, empty answer.
      if (content === null || content === undefined) {
        return {
          ok: true,
          content: '',
          finishReason,
          usage: readUsage(parsed.usage),
          durationMs
        }
      }
      return { ok: false, code: 'invalid_response', message: 'The Paper Instruments response carried an unexpected answer shape.' }
    }
    return { ok: true, content, finishReason, usage: readUsage(parsed.usage), durationMs }
  } catch (error) {
    if (error instanceof HttpTestError) {
      const cancelledAborted = requestInput.externalSignal?.aborted === true
      if (cancelledAborted) {
        return { ok: false, code: 'timeout', message: 'The generation was cancelled before it finished.' }
      }
      return { ok: false, code: 'timeout', message: error.message }
    }
    const mapped = mapNetwork(error)
    return { ok: false, code: mapped.code, message: mapped.message }
  }
}
