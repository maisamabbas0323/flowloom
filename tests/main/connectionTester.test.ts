import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConnectionTester } from '../../src/main/services/connectionTests'
import { ConfigService } from '../../src/main/config/service'
import { SecretsVault } from '../../src/main/config/vault'
import { defaultSettings, type PersistedSettings } from '../../src/main/config/settingsSchema'
import { JsonStore } from '../../src/main/lib/jsonStore'
import { createLogger } from '../../src/main/lib/log'
import type { EnvSource } from '../../src/main/env/envSource'

/**
 * Orchestrator tests: the ConnectionTester must refuse to make any
 * network request until required fields exist, must be injectable with a
 * mock fetch, and must persist real outcomes (not invented ones).
 * Same caveat as providers.test.ts: responses are controlled mocks —
 * these are not live provider connections.
 */

const vaultAdapter = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (blob: string) => Buffer.from(blob, 'base64').toString('utf8')
}

function makeStack(envValues: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-tester-'))
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
  return { config, logger }
}

type FetchMock = typeof globalThis.fetch

/** A fetch that should never be reached — used to prove no calls happen. */
function dummyFetch(): FetchMock {
  return async (input) => {
    throw new Error(`unexpected network call in test: ${String(input)}`)
  }
}

interface RecordedCall {
  url: string
  auth: string | null
  apiKey: string | null
  body: string
}

function recorder(okBody: string, okStatus = 200) {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchMock = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      auth: headers.get('Authorization'),
      apiKey: headers.get('x-bb-api-key') ?? headers.get('xi-api-key'),
      body: typeof init?.body === 'string' ? init.body : ''
    })
    return new Response(okBody, { status: okStatus })
  }
  return { calls, fetchImpl }
}

describe('ConnectionTester orchestration', () => {
  it('returns unconfigured without touching the network when the provider is unset', async () => {
    const { config, logger } = makeStack({})
    const tester = new ConnectionTester({ config, logger, fetchImpl: dummyFetch() })
    const result = await tester.runModelTest()
    expect(result.status).toBe('failed')
    expect(result.code).toBe('unconfigured')
  })

  it('asks for the model ID when only an API key exists', async () => {
    const { config, logger } = makeStack({ GOOGLE_API_KEY: 'k' })
    await config.saveModel({ provider: 'google' })
    const tester = new ConnectionTester({ config, logger, fetchImpl: dummyFetch() })
    const result = await tester.runModelTest()
    expect(result.code).toBe('unconfigured')
    expect(result.message).toMatch(/model ID/i)
  })

  it('does not switch providers, models, or keys behind the user\'s back', async () => {
    const env: Record<string, string> = { FLOWLOOM_MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-k' }
    const { config, logger } = makeStack(env)
    await config.saveModel({ modelId: 'vendor/model-1' })

    const { calls, fetchImpl } = recorder(JSON.stringify({ choices: [] }))
    const tester = new ConnectionTester({ config, logger, fetchImpl })
    const result = await tester.runModelTest()
    expect(result.status).toBe('connected')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('openrouter.ai')
    expect(calls[0]?.body).toContain('vendor/model-1')
    expect(calls[0]?.auth).toBe('Bearer or-k')
  })

  it('runs the model test against the user-supplied model id and persists the outcome', async () => {
    const { config, logger } = makeStack({})
    await config.saveModel({ provider: 'google', modelId: 'user-gemma-x' })
    await config.saveModel({ googleApiKey: 'g-k' })

    const { calls, fetchImpl } = recorder('{}')
    const tester = new ConnectionTester({ config, logger, fetchImpl })
    const result = await tester.runModelTest()
    expect(result.status).toBe('connected')
    expect(calls.some((call) => call.url.includes('/models/user-gemma-x:generateContent'))).toBe(true)
    expect(config.describe().tests.model?.status).toBe('connected')
  })

  it('persists real failures too', async () => {
    const { config, logger } = makeStack({})
    await config.saveModel({ provider: 'openrouter', modelId: 'nope/model' })
    await config.saveModel({ openrouterApiKey: 'k' })

    const calls: string[] = []
    const fetchImpl: FetchMock = async () => {
      calls.push('hit')
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
    }
    const tester = new ConnectionTester({ config, logger, fetchImpl })
    const result = await tester.runModelTest()
    expect(result.status).toBe('failed')
    expect(result.code).toBe('auth')
    expect(config.describe().tests.model?.status).toBe('failed')
    expect(config.describe().tests.model?.message).toMatch(/OpenRouter/i)
  })

  it('returns unconfigured for voice without a voice ID (never invents one)', async () => {
    const { config, logger } = makeStack({ ELEVENLABS_API_KEY: 'k' })
    const { calls, fetchImpl } = recorder('{}')
    const tester = new ConnectionTester({ config, logger, fetchImpl })
    const result = await tester.runVoiceTest()
    expect(result.code).toBe('unconfigured')
    expect(calls).toEqual([])
  })

  it('returns unconfigured for browser without a project ID', async () => {
    const { config, logger } = makeStack({ BROWSERBASE_API_KEY: 'k' })
    const { calls, fetchImpl } = recorder('{}')
    const tester = new ConnectionTester({ config, logger, fetchImpl })
    const result = await tester.runBrowserTest()
    expect(result.code).toBe('unconfigured')
    expect(calls).toEqual([])
  })

  it('refuses a duplicate concurrent test instead of racing', async () => {
    const { config, logger } = makeStack({ FLOWLOOM_MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' })
    await config.saveModel({ modelId: 'vendor/m' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let hits = 0
    const fetchImpl: FetchMock = async () => {
      hits += 1
      await gate
      return new Response(JSON.stringify({ choices: [] }), { status: 200 })
    }
    const tester = new ConnectionTester({ config, logger, fetchImpl })
    const first = tester.runModelTest()
    const second = await tester.runModelTest()
    expect(second.code).toBe('unknown')
    expect(second.message).toMatch(/already running/i)
    void release()
    const settled = await first
    expect(settled.status).toBe('connected')
    expect(hits).toBe(1)
  })
})
