import type { ProviderContext } from './types'

/**
 * Shared HTTP plumbing for provider tests: a single request helper with a
 * hard timeout, JSON passesthrough, and provider-error extraction.
 * Success means an actual HTTP 2xx (or a documented 2xx-adjacent case) —
 * never "the fields were filled in".
 */

const DEFAULT_TIMEOUT_MS = 20_000

export interface HttpResponse {
  status: number
  bodyText: string
  /** Present only when `binary: true` (text and bytes cannot both be read). */
  bodyBytes?: Buffer
}

export class HttpTestError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly bodyText: string,
    message: string
  ) {
    super(message)
  }
}

/**
 * Performs one request with a hard timeout. Every path (2xx, 4xx, 5xx,
 * network failure, timeout) resolves with a structured response instead
 * of throwing except where unknown; network failures and timeouts throw
 * `HttpTestError` with status null and are handled by callers.
 */
export async function request(
  ctx: ProviderContext,
  options: {
    url: string
    method: 'GET' | 'POST' | 'DELETE'
    headers: Record<string, string>
    body?: string
    timeoutMs?: number
    /** Read the body as raw bytes instead of text (for audio payloads). */
    binary?: boolean
    /**
     * A caller-owned cancellation signal (e.g. the engine's run signal).
     * Aborting it kills the request immediately — and the abort is
     * distinguishable from the timeout below.
     */
    externalSignal?: AbortSignal
  }
): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let externalAborted = false
  const onExternalAbort = (): void => {
    externalAborted = true
    controller.abort()
  }
  if (options.externalSignal) {
    if (options.externalSignal.aborted) onExternalAbort()
    else options.externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const response = await ctx.fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    })
    if (options.binary) {
      const bytes = await response.arrayBuffer().catch(() => new ArrayBuffer(0))
      return { status: response.status, bodyText: '', bodyBytes: Buffer.from(bytes) }
    }
    const bodyText = await response.text().catch(() => '')
    return { status: response.status, bodyText }
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    if (aborted) {
      if (externalAborted) {
        throw new HttpTestError(null, '', 'Request cancelled.')
      }
      throw new HttpTestError(null, '', `Request timed out after ${Math.round(timeoutMs / 1000)} s.`)
    }
    throw new HttpTestError(null, '', 'Network request failed before a response was received.')
  } finally {
    clearTimeout(timer)
    if (options.externalSignal) {
      options.externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

/** Extracts a provider's error message without ever returning credentials. */
export function extractProviderErrorText(bodyText: string): string | undefined {
  if (!bodyText || bodyText.length > 20_000) return undefined
  try {
    const parsed = JSON.parse(bodyText) as unknown
    const message =
      (parsed as { error?: { message?: unknown } })?.error?.message ??
      (parsed as { message?: unknown })?.message ??
      (typeof parsed === 'string' ? parsed : undefined)
    if (typeof message === 'string' && message.length > 0 && message.length < 500) {
      return message.replace(/\s+/g, ' ').trim()
    }
  } catch {
    // Not JSON — the body may be plain text; keep a bounded excerpt.
    const text = bodyText.replace(/\s+/g, ' ').trim()
    if (text.length > 0 && text.length < 300) return text
  }
  return undefined
}

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 404) return 'not found'
  if (status === 429) return 'rate limit'
  if (status >= 500) return 'server error'
  return `status ${status}`
}

export const providerErrorHint = extractProviderErrorText

export function isTimeoutError(error: unknown): boolean {
  return error instanceof HttpTestError && error.message.startsWith('Request timed out')
}

/** Maps a thrown request error to a structured, honest failure. */
export function networkFailure(error: unknown, host: string): {
  code: 'timeout' | 'server_unreachable'
  message: string
} {
  if (isTimeoutError(error)) {
    return { code: 'timeout', message: `The connection to ${host} timed out. Check your network connection.` }
  }
  return { code: 'server_unreachable', message: `Could not reach ${host}. Check the address, the server's status, and your network connection.` }
}
