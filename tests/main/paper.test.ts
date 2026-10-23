import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  testPaperInstruments,
  fetchPaperBalance,
  generatePaperCompletion,
  mapPaperError,
  formatNanodollars,
  PAPER_INSTRUMENTS_BASE_URL
} from '../../src/main/providers/paperinstruments'
import type { FetchLike, FetchResponseLike, ProviderContext } from '../../src/main/providers/types'
import { ConnectionTester } from '../../src/main/services/connectionTests'
import { ConfigService } from '../../src/main/config/service'
import { SecretsVault } from '../../src/main/config/vault'
import { defaultSettings, type PersistedSettings } from '../../src/main/config/settingsSchema'
import { JsonStore } from '../../src/main/lib/jsonStore'
import { createLogger } from '../../src/main/lib/log'
import type { EnvSource } from '../../src/main/env/envSource'

/**
 * Paper Instruments (Ultramarine API) tests driven with controlled mock
 * HTTP responses against the real provider module. These are mock-
 * response tests, NOT live provider connectivity — no billable request is
 * ever sent and no real credentials exist here. Figures asserted in these
 * tests are literals from the controlled mock bodies, never invented.
 */

interface MockRoute {
  match(url: string, method: string): boolean
  respond(url: string): { status: number; body?: string }
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
      text: async () => answer.body ?? '',
      arrayBuffer: async () => new ArrayBuffer(0)
    }
    return response
  }
}

function ctx(routes: MockRoute[], overrides?: Partial<ProviderContext>): ProviderContext {
  return { fetch: makeFetch(routes), timeoutMs: 5000, ...overrides }
}

const modelsRoute = (seen: MockRoute['seen'], body = JSON.stringify({ data: [{ id: 'pi-model-a' }] }), status = 200): MockRoute => ({
  match: (url, method) => url === `${PAPER_INSTRUMENTS_BASE_URL}/models` && method === 'GET',
  respond: () => ({ status, body }),
  seen
})

const modelRoute = (seen: MockRoute['seen'], id: string, status = 200, body = '{}'): MockRoute => ({
  match: (url, method) => url === `${PAPER_INSTRUMENTS_BASE_URL}/models/${encodeURIComponent(id)}` && method === 'GET',
  respond: () => ({ status, body }),
  seen
})

const usageRoute = (seen: MockRoute['seen'], body: string, status = 200): MockRoute => ({
  match: (url, method) => url === `${PAPER_INSTRUMENTS_BASE_URL}/usage` && method === 'GET',
  respond: () => ({ status, body }),
  seen
})

const completionRoute = (seen: MockRoute['seen'], body: string, status = 200): MockRoute => ({
  match: (url, method) => url === `${PAPER_INSTRUMENTS_BASE_URL}/chat/completions` && method === 'POST',
  respond: () => ({ status, body }),
  seen
})

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

describe('Paper Instruments error mapping (documented table)', () => {
  it('maps 401 to an auth failure', () => {
    const mapped = mapPaperError(401, '{"error":{"code":"invalid_api_key","message":"bad key"}}')
    expect(mapped.code).toBe('auth')
  })

  it('names a suspended billing account on 403', () => {
    const mapped = mapPaperError(403, '{"error":{"code":"billing_account_suspended"}}')
    expect(mapped.code).toBe('auth')
    expect(mapped.message).toMatch(/suspended/i)
  })

  it('maps 404 to model_not_found naming the model id', () => {
    const mapped = mapPaperError(404, '{"error":{"code":"model_not_found"}}', { modelId: 'pi-model-x' })
    expect(mapped.code).toBe('model_not_found')
    expect(mapped.message).toContain('pi-model-x')
  })

  it('splits the two 429 kinds — insufficient_quota is a credit failure, not a rate limit', () => {
    expect(mapPaperError(429, '{"error":{"code":"insufficient_quota"}}').code).toBe('insufficient_credit')
    expect(mapPaperError(429, '{"error":{"code":"rate_limit_exceeded"}}').code).toBe('rate_limit')
    expect(mapPaperError(429, '{"error":{"code":"concurrency_limit_exceeded"}}').code).toBe('rate_limit')
  })

  it('maps 400 invalid_value with a model param onto model_not_found', () => {
    const mapped = mapPaperError(400, '{"error":{"code":"invalid_value","param":"model"}}', { modelId: 'pi-model-x' })
    expect(mapped.code).toBe('model_not_found')
    expect(mapped.message).toContain('pi-model-x')
  })

  it('maps 5xx to a server-side failure that is not claimed as a Flowloom fault', () => {
    const mapped = mapPaperError(502, '{"error":{"message":"upstream"}}')
    expect(mapped.code).toBe('server_error')
  })
})

describe('formatNanodollars (1 USD = 1e9 nanodollars per the billing docs)', () => {
  it('converts real figures without inventing anything', () => {
    expect(formatNanodollars(5_000_000_000)).toBe('$5.00')
    expect(formatNanodollars(483_000_000)).toBe('$0.48')
    expect(formatNanodollars(0)).toBe('$0.00')
  })
})

/* ------------------------------------------------------------------ */
/* Free connection test                                                */
/* ------------------------------------------------------------------ */

describe('Paper Instruments connection test (free endpoints only)', () => {
  it('verifies models → model → usage and reports the real balance verbatim', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [
      modelsRoute(seen),
      modelRoute(seen, 'pi-model-a'),
      usageRoute(seen, JSON.stringify({ available_nanodollars: 4_830_000_000, reserved_nanodollars: 0 }))
    ]
    const result = await testPaperInstruments(ctx(routes), { apiKey: 'pi_live_test', modelId: 'pi-model-a' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('$4.83')
    expect(result.message).toContain('(reserved: $0.00)')
    expect(seen).toHaveLength(3)
    expect(seen[0]?.url).toBe(`${PAPER_INSTRUMENTS_BASE_URL}/models`)
    expect(seen[1]?.url).toContain('/models/pi-model-a')
    expect(seen[2]?.url).toBe(`${PAPER_INSTRUMENTS_BASE_URL}/usage`)
    for (const call of seen) expect(call.headers['Authorization']).toBe('Bearer pi_live_test')
  })

  it('stops at the first failure and invents no balance figure', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [modelsRoute(seen, JSON.stringify({}), 401)]
    const result = await testPaperInstruments(ctx(routes), { apiKey: 'pi_live_test', modelId: 'pi-model-a' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('auth')
    expect(seen).toHaveLength(1) // /usage is never reached after auth fails
  })

  it('reports an unknown model id without substituting a different one', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [
      modelsRoute(seen),
      modelRoute(seen, 'pi-model-missing', 404, '{"error":{"code":"model_not_found"}}')
    ]
    const result = await testPaperInstruments(ctx(routes), { apiKey: 'pi_live_test', modelId: 'pi-model-missing' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('model_not_found')
    expect(result.message).toContain('pi-model-missing')
  })

  it('stays honest when the usage response carries no balance figure', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [modelsRoute(seen), modelRoute(seen, 'pi-model-a'), usageRoute(seen, '{"available":null}')]
    const result = await testPaperInstruments(ctx(routes), { apiKey: 'pi_live_test', modelId: 'pi-model-a' })
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/did not include a balance figure/i)
    expect(result.message).not.toMatch(/\$\d/)
  })

  it('stays honest when the usage body cannot be parsed at all', async () => {
    const seen: MockRoute['seen'] = []
    const routes = [modelsRoute(seen), modelRoute(seen, 'pi-model-a'), usageRoute(seen, '<html>oops</html>')]
    const result = await testPaperInstruments(ctx(routes), { apiKey: 'pi_live_test', modelId: 'pi-model-a' })
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/could not be read/i)
  })
})

describe('fetchPaperBalance', () => {
  it('reads only the documented numeric fields', async () => {
    const seen: MockRoute['seen'] = []
    const balance = await fetchPaperBalance(
      ctx([usageRoute(seen, '{"available_nanodollars":1500000000,"reserved_nanodollars":50000000,"other":"x"}')]),
      'pi_live_test'
    )
    expect(balance).toEqual({ availableNanodollars: 1_500_000_000, reservedNanodollars: 50_000_000 })
  })

  it('refuses to invent a balance when numbers are missing', async () => {
    const balance = await fetchPaperBalance(ctx([usageRoute([], '{}')]), 'pi_live_test')
    expect(balance).toEqual({ availableNanodollars: null, reservedNanodollars: null })
  })
})

/* ------------------------------------------------------------------ */
/* Generation (billable)                                               */
/* ------------------------------------------------------------------ */

describe('generatePaperCompletion (billable — always user-initiated in the app)', () => {
  it('sends one non-streaming request with the documented body fields', async () => {
    const seen: MockRoute['seen'] = []
    const completion = completionRoute(
      seen,
      JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 }, total_tokens: 14 } })
    )
    const result = await generatePaperCompletion(ctx([completion]), { apiKey: 'pi_live_test' }, {
      model: 'pi-model-a',
      system: 'be brief',
      prompt: 'hi',
      maxCompletionTokens: 128,
      reasoningEffort: 'low',
      jsonMode: false
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe('hello')
      expect(result.finishReason).toBe('stop')
      expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 5, reasoningTokens: 2, totalTokens: 14 })
    }
    expect(seen).toHaveLength(1)
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>
    expect(body['model']).toBe('pi-model-a')
    expect(body['reasoning_effort']).toBe('low')
    expect(body['max_completion_tokens']).toBe(128)
    expect(body['stream']).toBe(false)
    expect(body['response_format']).toBeUndefined()
    const messages = body['messages'] as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user')
  })

  it('requests json_object mode only when a schema is configured', async () => {
    const seen: MockRoute['seen'] = []
    const completion = completionRoute(
      seen,
      JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    )
    await generatePaperCompletion(ctx([completion]), { apiKey: 'pi_live_test' }, {
      model: 'pi-model-a',
      prompt: 'give json',
      maxCompletionTokens: 64,
      reasoningEffort: 'low',
      jsonMode: true
    })
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>
    expect(body['response_format']).toEqual({ type: 'json_object' })
  })

  it('maps insufficient_quota to insufficient_credit so the UI can ask for funds', async () => {
    const completion = completionRoute([], '{"error":{"code":"insufficient_quota"}}', 429)
    const result = await generatePaperCompletion(ctx([completion]), { apiKey: 'pi_live_test' }, {
      model: 'pi-model-a',
      prompt: 'hi',
      maxCompletionTokens: 128,
      reasoningEffort: 'low'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('insufficient_credit')
  })

  it('accepts an empty content with finish_reason length as a real (truncated) reply', async () => {
    const completion = completionRoute(
      [],
      JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { total_tokens: 128, completion_tokens: 128, completion_tokens_details: { reasoning_tokens: 128 } } })
    )
    const result = await generatePaperCompletion(ctx([completion]), { apiKey: 'pi_live_test' }, {
      model: 'pi-model-a',
      prompt: 'hi',
      maxCompletionTokens: 128,
      reasoningEffort: 'low'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe('')
      expect(result.finishReason).toBe('length')
    }
  })

  it('recognises an owner-side cancel distinctly from a timeout', async () => {
    const abort = new AbortController()
    const pending = generatePaperCompletion(
      { fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted.')
          error.name = 'AbortError'
          reject(error)
        })
      }), timeoutMs: 5000 },
      { apiKey: 'pi_live_test' },
      { model: 'pi-model-a', prompt: 'hi', maxCompletionTokens: 128, reasoningEffort: 'low', externalSignal: abort.signal }
    )
    // Cancel mid-flight — well before the 5-second request timeout would.
    setTimeout(() => abort.abort(), 50)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('timeout')
      expect(result.message).toMatch(/cancelled/i)
    }
  })
})

/* ------------------------------------------------------------------ */
/* Settings surface (save / precedence / lastTest clearing)             */
/* ------------------------------------------------------------------ */

const vaultAdapter = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (blob: string) => Buffer.from(blob, 'base64').toString('utf8')
}

function makeStack(envValues: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-paper-'))
  const env: EnvSource = { getPath: () => null, read: () => ({ ...envValues }) }
  const logger = createLogger({ redact: (t) => t, setSecrets: () => undefined })
  const config = new ConfigService({
    settings: new JsonStore<PersistedSettings>(path.join(dir, 'settings.json'), defaultSettings, logger),
    env,
    vault: new SecretsVault(path.join(dir, 'secrets.json'), vaultAdapter, logger),
    logger,
    secureStorage: vaultAdapter,
    appVersion: 'test',
    platform: 'linux'
  })
  return { dir, config, logger }
}

describe('Paper Instruments settings', () => {
  it('saves the key, model, preferences, and clears the previous test only on credential change', async () => {
    const { config } = makeStack({})
    const first = config.savePaper({
      apiKey: 'pi_live_one',
      model: 'pi-model-a',
      enabled: true,
      minBalanceUsd: 2.5
    })
    expect(first.ok).toBe(true)
    config.recordTest('paper', { status: 'connected', code: 'unknown', message: 'ok', at: new Date().toISOString(), durationMs: 1 })
    expect(config.describe().paper.apiKey.configured).toBe(true)
    expect(config.describe().paper.model.value).toBe('pi-model-a')
    expect(config.describe().paper.preferences.enabled).toBe(true)
    expect(config.describe().paper.preferences.minBalanceUsd).toBe(2.5)
    expect(config.describe().tests.paper?.status).toBe('connected')

    // Preferences only: the verified connection result stays valid.
    const prefs = config.savePaper({ enabled: false, minBalanceUsd: 5 })
    expect(prefs.ok).toBe(true)
    expect(config.describe().tests.paper?.status).toBe('connected')
    expect(config.getPaperEnabled()).toBe(false)
    expect(config.getPaperMinBalanceUsd()).toBe(5)

    // A credential change invalidates the previous verification honestly.
    const rekey = config.savePaper({ apiKey: 'pi_live_two' })
    expect(rekey.ok).toBe(true)
    expect(config.describe().tests.paper).toBeUndefined()
  })

  it('validates the model charset and the 0–100 spending-stop range', () => {
    const { config } = makeStack({})
    const badModel = config.savePaper({ model: 'pi model!!' })
    expect(badModel.errors['model']).toBeTruthy()
    const badStop = config.savePaper({ minBalanceUsd: 250 })
    expect(badStop.errors['minBalanceUsd']).toBeTruthy()
  })

  it('honors the .env fallback with Settings overrides winning', () => {
    const { config } = makeStack({ PAPERINSTRUMENTS_API_KEY: 'pi_live_env', PAPERINSTRUMENTS_MODEL: 'env-model-1' })
    const described = config.describe().paper
    expect(described.apiKey.configured).toBe(true)
    expect(described.model.value).toBe('env-model-1')
    expect(config.getEffectivePaperModel()).toBe('env-model-1')
    const saved = config.savePaper({ apiKey: 'pi_live_settings', model: 'settings-model-1' })
    expect(saved.ok).toBe(true)
    expect(config.getEffectivePaperModel()).toBe('settings-model-1')
    const cleared = config.savePaper({ model: null })
    expect(cleared.ok).toBe(true)
    expect(config.getEffectivePaperModel()).toBe('env-model-1')
  })

  it('refuses the free connection test before its endpoints when unconfigured', async () => {
    const { config, logger } = makeStack({})
    const tester = new ConnectionTester({
      config,
      logger,
      fetchImpl: async (input) => {
        throw new Error(`unexpected network call in test: ${String(input)}`)
      }
    })
    const noKey = await tester.runPaperTest()
    expect(noKey.status).toBe('failed')
    expect(noKey.code).toBe('unconfigured')
    await config.savePaper({ apiKey: 'pi_live_test' })
    const noModel = await tester.runPaperTest()
    expect(noModel.status).toBe('failed')
    expect(noModel.code).toBe('unconfigured')
    expect(noModel.message).toMatch(/model ID/i)
  })
})
