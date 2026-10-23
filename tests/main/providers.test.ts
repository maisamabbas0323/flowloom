import { describe, expect, it } from 'vitest'

import { testGoogle } from '../../src/main/providers/google'
import { testOpenRouter } from '../../src/main/providers/openrouter'
import { testOllama, checkModelInstalled } from '../../src/main/providers/ollama'
import { testVoiceConnection, testVoiceGeneration } from '../../src/main/providers/elevenlabs'
import { testBrowserbase } from '../../src/main/providers/browserbase'
import type { FetchLike, FetchResponseLike, ProviderContext } from '../../src/main/providers/types'

/**
 * Connection tests driven with controlled mock HTTP responses.
 * These verify request/response handling, error mapping and cleanup of
 * the real provider modules — they are mock-response tests, NOT live
 * provider connectivity (no real credentials are available here).
 */

const KEY_401 = 'Invalid key'
const BODY_401 = JSON.stringify({ error: { message: KEY_401 } })
const BODY_404 = JSON.stringify({ error: { message: 'No endpoints found for model' } })
const BODY_400_NAME = 'models/does-not-exist is not found for API version v1beta'
const BODY_400 = JSON.stringify({ error: { message: BODY_400_NAME } })
const BODY_KEY_INVALID = 'API key not valid. Please pass a valid API key.'
const BODY_GOOGLE_KEY = JSON.stringify({ error: { message: BODY_KEY_INVALID } })

interface MockRoute {
  match(url: string, method: string): boolean
  respond(url: string): {
    status: number
    body?: string
    bytes?: Uint8Array
  }
  seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>
}

function makeFetch(routes: MockRoute[]): FetchLike {
  return async (url, init) => {
    const method = init.method
    const route = routes.find((r) => r.match(url, method))
    if (!route) throw new Error(`No mock route for ${method} ${url}`)
    route.seen.push({ url, method, headers: init.headers, body: init.body })
    const answer = route.respond(url)
    const response: FetchResponseLike = {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: String(answer.status),
      text: async () => answer.body ?? (answer.bytes ? '[binary]' : ''),
      arrayBuffer: async () =>
        answer.bytes
          ? (answer.bytes.buffer.slice(
              answer.bytes.byteOffset,
              answer.bytes.byteOffset + answer.bytes.byteLength
            ) as ArrayBuffer)
          : new ArrayBuffer(0)
    }
    return response
  }
}

function ctx(routes: MockRoute[], overrides?: Partial<ProviderContext>): ProviderContext {
  return { fetch: makeFetch(routes), timeoutMs: 5000, ...overrides }
}

const abortingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.')
      error.name = 'AbortError'
      reject(error)
    })
  })

function networkFailingFetch(): FetchLike {
  return async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:11434')
  }
}

/* ------------------------------------------------------------------ */
/* Google                                                              */
/* ------------------------------------------------------------------ */

describe('Google provider test', () => {
  it('verifies auth and model generation on success', async () => {
    const models: MockRoute = {
      match: (url, method) => url.includes('generativelanguage') && url.endsWith('/models') && method === 'GET',
      respond: () => ({ status: 200, body: JSON.stringify({ models: [] }) }),
      seen: []
    }
    const generate: MockRoute = {
      match: (url, method) => url.includes(':generateContent') && method === 'POST',
      respond: () => ({ status: 200, body: JSON.stringify({ candidates: [] }) }),
      seen: []
    }
    const result = await testGoogle(ctx([models, generate]), { apiKey: 'k', modelId: 'gemma-x' })
    expect(result.ok).toBe(true)
    expect(generate.seen[0]?.body).toContain('maxOutputTokens')
    expect(generate.seen[0]?.url).toContain('/models/gemma-x:generateContent')
  })

  it('maps invalid API keys to an auth failure (Google emits 400)', async () => {
    const models: MockRoute = {
      match: () => true,
      respond: () => ({ status: 400, body: BODY_GOOGLE_KEY }),
      seen: []
    }
    const result = await testGoogle(ctx([models]), { apiKey: 'k', modelId: 'gemma-x' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('auth')
  })

  it('maps unknown model ids to a model_not_found failure without inventing a model', async () => {
    const okModels: MockRoute = {
      match: (url) => url.endsWith('/models'),
      respond: () => ({ status: 200, body: '{}' }),
      seen: []
    }
    const generate: MockRoute = {
      match: () => true,
      respond: () => ({ status: 404, body: BODY_400 }),
      seen: []
    }
    const result = await testGoogle(ctx([okModels, generate]), { apiKey: 'k', modelId: 'does-not-exist' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('model_not_found')
    expect(result.message).toContain('does-not-exist')
  })

  it('maps network failure to server_unreachable and timeout to timeout', async () => {
    const unreachable = await testGoogle({ fetch: networkFailingFetch(), timeoutMs: 100 }, {
      apiKey: 'k',
      modelId: 'm'
    })
    expect(unreachable.code).toBe('server_unreachable')
    const timingOut = await testGoogle({ fetch: abortingFetch, timeoutMs: 20 }, { apiKey: 'k', modelId: 'm' })
    expect(timingOut.code).toBe('timeout')
  })
})

/* ------------------------------------------------------------------ */
/* OpenRouter                                                          */
/* ------------------------------------------------------------------ */

describe('OpenRouter provider test', () => {
  it('sends a bearer-token chat completion and succeeds on 200', async () => {
    const route: MockRoute = {
      match: () => true,
      respond: () => ({ status: 200, body: JSON.stringify({ choices: [] }) }),
      seen: []
    }
    const result = await testOpenRouter(ctx([route]), { apiKey: 'or-key', modelId: 'vendor/model-1' })
    expect(result.ok).toBe(true)
    expect(route.seen[0]?.headers['Authorization']).toBe('Bearer or-key')
    expect(route.seen[0]?.body).toContain('vendor/model-1')
    expect(route.seen[0]?.body).toContain('"max_tokens":1')
  })

  it('maps 401 to auth and 404 to model_not_found', async () => {
    const auth: MockRoute = {
      match: () => true,
      respond: () => ({ status: 401, body: BODY_401 }),
      seen: []
    }
    expect((await testOpenRouter(ctx([auth]), { apiKey: 'k', modelId: 'm' })).code).toBe('auth')

    const missing: MockRoute = {
      match: () => true,
      respond: () => ({ status: 404, body: BODY_404 }),
      seen: []
    }
    expect((await testOpenRouter(ctx([missing]), { apiKey: 'k', modelId: 'm' })).code).toBe('model_not_found')
  })
})

/* ------------------------------------------------------------------ */
/* Ollama                                                              */
/* ------------------------------------------------------------------ */

describe('Ollama provider test', () => {
  it('reports an unreachable server honestly', async () => {
    const result = await testOllama({ fetch: networkFailingFetch(), timeoutMs: 100 }, {
      baseUrl: 'http://127.0.0.1:11434',
      modelId: 'gemma3:4b'
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('server_unreachable')
  })

  it('matches exact installed tags and verifies real generation', async () => {
    const tags: MockRoute = {
      match: (url) => url.endsWith('/api/tags'),
      respond: () => ({ status: 200, body: JSON.stringify({ models: [{ name: 'gemma3:4b' }, { name: 'llama3:8b' }] }) }),
      seen: []
    }
    const generate: MockRoute = {
      match: (url) => url.endsWith('/api/generate'),
      respond: () => ({ status: 200, body: JSON.stringify({ done: true }) }),
      seen: []
    }
    const result = await testOllama(ctx([tags, generate]), {
      baseUrl: 'http://127.0.0.1:11434/',
      modelId: 'gemma3:4b'
    })
    expect(result.ok).toBe(true)
    expect(generate.seen[0]?.body).toContain('gemma3:4b')
    expect(generate.seen[0]?.body).toContain('"num_predict":1')
  })

  it('does not silently accept a base-name match for a wrong tag', async () => {
    const tags: MockRoute = {
      match: () => true,
      respond: () => ({ status: 200, body: JSON.stringify({ models: [{ name: 'gemma3:4b' }] }) }),
      seen: []
    }
    const result = await testOllama(ctx([tags]), { baseUrl: 'http://127.0.0.1:11434', modelId: 'gemma3' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('model_not_found')
    expect(result.message).toContain('not installed exactly as typed')
  })

  it('sends an optional API key when one is configured', async () => {
    const withKey: MockRoute = {
      match: () => true,
      respond: () => ({ status: 200, body: JSON.stringify({ models: [{ name: 'm1' }] }) }),
      seen: []
    }
    const result = await testOllama(ctx([withKey]), {
      baseUrl: 'http://localhost:11434',
      modelId: 'm1',
      apiKey: 'ollama-key'
    })
    expect(result.ok).toBe(true)
    expect(withKey.seen[0]?.headers['Authorization']).toBe('Bearer ollama-key')
  })

  it('rejects invalid base URLs without any network call', async () => {
    const result = await testOllama(ctx([]), { baseUrl: 'ftp://nope', modelId: 'm' })
    expect(result.code).toBe('invalid_target')
    expect(result.ok).toBe(false)
  })

  it('checkModelInstalled unit behavior', () => {
    expect(checkModelInstalled(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }), 'gemma3:4b')).toBeNull()
    const wrongTag = checkModelInstalled(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }), 'gemma3:latest')
    expect(wrongTag).not.toBeNull()
    expect(checkModelInstalled('{}', 'anything')).not.toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* ElevenLabs                                                          */
/* ------------------------------------------------------------------ */

describe('ElevenLabs provider tests', () => {
  it('verifies the key via the account endpoint', async () => {
    const user: MockRoute = {
      match: () => true,
      respond: () => ({ status: 200, body: JSON.stringify({ tier: 'free' }) }),
      seen: []
    }
    const result = await testVoiceConnection(ctx([user]), { apiKey: 'xi-key' })
    expect(result.ok).toBe(true)
    expect(user.seen[0]?.headers['xi-api-key']).toBe('xi-key')
  })

  it('rejects an unknown voice id with voice_not_found — never inventing one', async () => {
    const user: MockRoute = {
      match: (url) => url.includes('/v1/user'),
      respond: () => ({ status: 200, body: '{}' }),
      seen: []
    }
    const voice: MockRoute = {
      match: () => true,
      respond: () => ({ status: 404, body: JSON.stringify({ detail: { message: 'voice not found' } }) }),
      seen: []
    }
    const outcome = await testVoiceGeneration(ctx([user, voice]), { apiKey: 'k', voiceId: 'no-such-voice' })
    expect(outcome.connection).not.toBeNull()
    expect(outcome.connection?.code).toBe('voice_not_found')
    expect(outcome.audio).toBeUndefined()
  })

  it('returns real audio bytes on success', async () => {
    const user: MockRoute = {
      match: (url) => url.includes('/v1/voices/'),
      respond: () => ({ status: 200, body: '{}' }),
      seen: []
    }
    const bytes = new Uint8Array([73, 68, 51, 3, 0, 0, 0, 15, 73, 68, 51, 10, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5])
    const tts: MockRoute = { match: () => true, respond: () => ({ status: 200, bytes }), seen: [] }
    const outcome = await testVoiceGeneration(ctx([user, tts]), { apiKey: 'k', voiceId: 'v1' })
    expect(outcome.connection).toBeNull()
    expect(outcome.audio?.mimeType).toBe('audio/mpeg')
    const decoded = Buffer.from(outcome.audio?.base64 ?? '', 'base64')
    expect(Array.from(decoded.slice(0, 5))).toEqual([73, 68, 51, 3, 0])
  })

  it('maps auth failure on the account endpoint', async () => {
    const user: MockRoute = {
      match: () => true,
      respond: () => ({ status: 401, body: JSON.stringify({ detail: { message: 'invalid_api_key' } }) }),
      seen: []
    }
    const result = await testVoiceConnection(ctx([user]), { apiKey: 'k' })
    expect(result.code).toBe('auth')
  })
})

/* ------------------------------------------------------------------ */
/* Browserbase                                                         */
/* ------------------------------------------------------------------ */

describe('Browserbase provider test', () => {
  it('verifies the key with a read-only GET /v1/sessions (no session created)', async () => {
    const list: MockRoute = {
      match: (url, method) => url.endsWith('/v1/sessions') && method === 'GET',
      respond: () => ({ status: 200, body: '[]' }),
      seen: []
    }
    const result = await testBrowserbase(ctx([list]), { apiKey: 'bb-key', projectId: 'proj-42' })
    expect(result.ok).toBe(true)
    expect(list.seen).toHaveLength(1)
    expect(list.seen[0]?.headers['x-bb-api-key']).toBe('bb-key')
    expect(list.seen[0]?.method).toBe('GET')
  })

  it('never issues a POST/DELETE — no billable session can be created by a test', async () => {
    const anyRoute: MockRoute = {
      match: () => true,
      respond: () => ({ status: 200, body: '[]' }),
      seen: []
    }
    await testBrowserbase(ctx([anyRoute]), { apiKey: 'k', projectId: 'p' })
    const methods = anyRoute.seen.map((call) => call.method)
    expect(methods.every((method) => method === 'GET')).toBe(true)
  })

  it('rejects a malformed project id without a network call', async () => {
    const result = await testBrowserbase(ctx([]), { apiKey: 'k', projectId: 'bad id!' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_target')
  })

  it('maps auth failure (401) to an honest auth error', async () => {
    const list: MockRoute = {
      match: () => true,
      respond: () => ({ status: 401, body: JSON.stringify({ message: 'Invalid API key' }) }),
      seen: []
    }
    const result = await testBrowserbase(ctx([list]), { apiKey: 'k', projectId: 'proj1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('auth')
  })

  it('maps rate limiting and unexpected server responses', async () => {
    const limited: MockRoute = {
      match: () => true,
      respond: () => ({ status: 429, body: '{}' }),
      seen: []
    }
    const rateLimited = await testBrowserbase(ctx([limited]), { apiKey: 'k', projectId: 'proj1' })
    expect(rateLimited.code).toBe('rate_limit')

    const broken: MockRoute = {
      match: () => true,
      respond: () => ({ status: 503, body: 'maintenance' }),
      seen: []
    }
    const serverError = await testBrowserbase(ctx([broken]), { apiKey: 'k', projectId: 'proj1' })
    expect(serverError.code).toBe('server_error')
  })
})
