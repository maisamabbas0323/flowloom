import { request, extractProviderErrorText, networkFailure } from './http'
import { failure, success, type ProviderContext, type ProviderTestResult } from './types'

/**
 * Ollama connection test.
 *
 * Talks to the user-configured local (or remote) Ollama server using its
 * supported API:
 *   1. GET /api/tags — proves the server is running.
 *   2. POST /api/generate with `num_predict: 1` — proves the exact model
 *      tag the user provided is installed and can actually generate.
 * No API key is required for endpoints that don't need authentication.
 */
export async function testOllama(
  ctx: ProviderContext,
  input: { baseUrl: string; modelId: string; apiKey?: string | null }
): Promise<ProviderTestResult> {
  const base = normalizeBase(input.baseUrl)
  if (!base) {
    return failure(
      'invalid_target',
      'The Ollama base URL is invalid. Use a full URL such as http://127.0.0.1:11434.'
    )
  }
  const host = describeOllamaHost(base)

  // Step 1 — server reachable?
  try {
    const response = await request(ctx, {
      url: `${base}/api/tags`,
      method: 'GET',
      headers: ollamaHeaders(input.apiKey),
      timeoutMs: 15_000
    })
    if (response.status === 401 || response.status === 403) {
      return failure(
        'auth',
        'The Ollama server requires authentication. Add the API key for this server.'
      )
    }
    if (response.status !== 200) {
      return failure('server_error', `The Ollama server answered with an unexpected response (HTTP ${response.status}).`)
    }
    const notInstalled = checkModelInstalled(response.bodyText, input.modelId)
    if (notInstalled) {
      return failure(
        'model_not_found',
        notInstalled.message,
        notInstalled.detail
      )
    }
  } catch (error) {
    const mapped = networkFailure(error, host)
    return failure(
      mapped.code,
      mapped.code === 'server_unreachable'
        ? `Could not reach an Ollama server at ${host}. Is it running?`
        : mapped.message
    )
  }

  // Step 2 — the model can actually generate (may load weights; slower).
  try {
    const response = await request(ctx, {
      url: `${base}/api/generate`,
      method: 'POST',
      headers: ollamaHeaders(input.apiKey),
      body: JSON.stringify({
        model: input.modelId,
        prompt: 'ping',
        stream: false,
        options: { num_predict: 1 }
      }),
      timeoutMs: 60_000
    })
    if (response.status === 200) {
      const payload = parseJson(response.bodyText)
      if (payload && typeof payload === 'object' && 'done' in payload) {
        return success(
          'Connection verified. The Ollama server generated a minimal response with the selected model.'
        )
      }
      return success('Connection verified with the Ollama server and the selected model.')
    }
    if (response.status === 404) {
      return failure(
        'model_not_found',
        `The model "${input.modelId}" is not available on this Ollama server. Pull it first (e.g. via "ollama pull <model>").`,
        providerHint(response.bodyText)
      )
    }
    return failure(
      'model_not_found',
      `The Ollama server refused the model "${input.modelId}".`,
      providerHint(response.bodyText)
    )
  } catch (error) {
    const mapped = networkFailure(error, host)
    return failure(
      mapped.code,
      mapped.code === 'timeout'
        ? 'The Ollama server did not finish loading the model in time. Try again — first runs can be slow.'
        : mapped.message
    )
  }
}

/** Parse /api/tags and validate the model is installed exactly as supplied. */
export function checkModelInstalled(
  tagsBodyText: string,
  modelId: string
): { message: string; detail?: string } | null {
  const payload = parseJson(tagsBodyText)
  const names = (payload as { models?: Array<{ name?: string }> } | null)?.models
    ?.map((m) => (typeof m?.name === 'string' ? m.name : ''))
    .filter((name) => name !== '') ?? []
  if (names.length === 0) {
    return { message: 'The Ollama server is running, but reports no installed models.' }
  }
  if (names.includes(modelId)) return null
  const baseNames = new Set(names.map((name) => name.split(':')[0]))
  if (baseNames.has(modelId)) {
    return {
      message: `The Ollama server is running, but "${modelId}" is not installed exactly as typed.`,
      detail: `Installed tags include: ${names.slice(0, 5).join(', ')}. Ollama matches tags exactly — include the full tag (e.g. ${modelId}:latest if shown).`
    }
  }
  return {
    message: `The model "${modelId}" is not installed on this Ollama server.`,
    detail: `Installed models include: ${names.slice(0, 5).join(', ')}.`
  }
}

function ollamaHeaders(apiKey?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function normalizeBase(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    if (!parsed.hostname) return null
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`
  } catch {
    return null
  }
}

function describeOllamaHost(base: string): string {
  try {
    const parsed = new URL(base)
    return parsed.host || base
  } catch {
    return base
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function providerHint(bodyText: string): string | undefined {
  return extractProviderErrorText(bodyText)
}
