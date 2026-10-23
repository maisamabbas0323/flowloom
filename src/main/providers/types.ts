import type { FailureCode } from '../../shared/contracts'

/**
 * Everything a provider test needs. `fetch` is injectable so unit tests
 * can drive real code paths against controlled mock responses — this is
 * distinctly NOT a mock of the providers; the request/response handling
 * under test is the same code used for live connections.
 */
export interface ProviderContext {
  fetch: FetchLike
  timeoutMs: number
}

export type FetchLike = (
  url: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE'
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
  }
) => Promise<FetchResponseLike>

export interface FetchResponseLike {
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Result of one provider call inside the main process. */
export interface ProviderTestResult {
  ok: boolean
  code: FailureCode
  /** Human-readable summary; secrets are redacted by the caller. */
  message: string
  /** Optional diagnostic hint (provider error text), redacted by the caller. */
  hint?: string
}

export function failure(code: FailureCode, message: string, hint?: string): ProviderTestResult {
  return { ok: false, code, message, hint }
}

export function success(message: string, hint?: string): ProviderTestResult {
  return { ok: true, code: 'unknown', message, hint }
}
