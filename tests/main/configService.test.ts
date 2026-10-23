import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'

import { ConfigService } from '../../src/main/config/service'
import { SecretsVault, type SecureStorageAdapter } from '../../src/main/config/vault'
import { defaultSettings, type PersistedSettings } from '../../src/main/config/settingsSchema'
import { JsonStore } from '../../src/main/lib/jsonStore'
import { createLogger } from '../../src/main/lib/log'
import type { EnvSource } from '../../src/main/env/envSource'

void fs
void os

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-test-'))
  return dir
}

function nullLogger() {
  return createLogger({ redact: (t) => t, setSecrets: () => undefined })
}

function fakeEnv(values: Record<string, string>): EnvSource {
  return {
    getPath: () => (Object.keys(values).length > 0 ? '/tmp/fake/.env' : null),
    read: () => ({ ...values })
  }
}

function fakeStorage(available = true): SecureStorageAdapter {
  let counter = 0
  return {
    isAvailable: () => available,
    encrypt: (plain) => `enc#${++counter}#${btoaSafe(plain)}`,
    decrypt: (blob) => {
      if (!blob.startsWith('enc#')) return null
      return atobSafe(blob.split('#')[2] as string)
    }
  }
}

/** Deterministic base64 with unicode safety for test secrets (ASCII only). */
function btoaSafe(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}
function atobSafe(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8')
}

interface Harness {
  service: ConfigService
  dir: string
  envValues: Record<string, string>
  setEnv: (values: Record<string, string>) => void
}

function makeService(opts?: { storage?: SecureStorageAdapter; reuseDir?: string }): Harness {
  const dir = opts?.reuseDir ?? tmpDir()
  const envValues: Record<string, string> = {}
  const env: EnvSource = fakeEnv(envValues)
  const settings = new JsonStore<PersistedSettings>(
    path.join(dir, 'settings.json'),
    defaultSettings,
    nullLogger()
  )
  const vault = new SecretsVault(path.join(dir, 'secrets.json'), opts?.storage ?? fakeStorage(), nullLogger())
  const service = new ConfigService({
    settings,
    env,
    vault,
    logger: nullLogger(),
    secureStorage: opts?.storage ?? fakeStorage(),
    appVersion: 'test',
    platform: 'linux'
  })
  return {
    service,
    dir,
    envValues,
    setEnv(values) {
      for (const key of Object.keys(envValues)) delete envValues[key]
      Object.assign(envValues, values)
    }
  }
}

describe('configuration resolution precedence', () => {
  let harness: Harness
  beforeEach(() => {
    harness = makeService()
  })

  it('uses the saved Settings override over the .env value', () => {
    harness.setEnv({ FLOWLOOM_MODEL_PROVIDER: 'openrouter' })
    const saved = harness.service.saveModel({ provider: 'google' })
    expect(saved.ok).toBe(true)
    const view = saved.config
    expect(view.model.provider.value).toBe('google')
    expect(view.model.provider.source).toBe('settings')
  })

  it('falls back to the .env value when no override is saved', () => {
    harness.setEnv({ FLOWLOOM_MODEL_PROVIDER: 'openrouter', FLOWLOOM_MODEL_ID: 'v/gemma-x' })
    const view = harness.service.describe()
    expect(view.model.provider.value).toBe('openrouter')
    expect(view.model.provider.source).toBe('env')
    expect(view.model.modelId.value).toBe('v/gemma-x')
    expect(view.model.modelId.source).toBe('env')
  })

  it('treats a field as unconfigured when neither source provides it', () => {
    const view = harness.service.describe()
    expect(view.model.provider.value).toBe('')
    expect(view.model.provider.source).toBe('unset')
    expect(view.model.modelId.source).toBe('unset')
    expect(view.model.googleApiKey.configured).toBe(false)
  })

  it('clearing a saved override exposes the .env value again', () => {
    harness.setEnv({ FLOWLOOM_MODEL_ID: 'from-env-model' })
    const saved = harness.service.saveModel({ modelId: 'saved-model' })
    expect(saved.config.model.modelId.value).toBe('saved-model')
    const cleared = harness.service.clearOverride('model.modelId')
    expect(cleared.ok).toBe(true)
    expect(cleared.config.model.modelId.value).toBe('from-env-model')
    expect(cleared.config.model.modelId.source).toBe('env')
  })

  it('applies the documented Ollama default base URL', () => {
    const view = harness.service.describe()
    expect(view.model.ollamaBaseUrl.value).toBe('http://127.0.0.1:11434')
    expect(view.model.ollamaBaseUrl.source).toBe('default')
    // An .env value overrides the default, and a saved override overrides .env.
    harness.setEnv({ OLLAMA_BASE_URL: 'http://192.168.1.10:11434' })
    expect(harness.service.describe().model.ollamaBaseUrl.value).toBe('http://192.168.1.10:11434')
    harness.service.saveModel({ ollamaBaseUrl: 'http://10.0.0.2:11434' })
    expect(harness.service.describe().model.ollamaBaseUrl.value).toBe('http://10.0.0.2:11434')
    expect(harness.service.describe().model.ollamaBaseUrl.source).toBe('settings')
  })

  it('rejects an invalid provider with a helpful error and changes nothing', () => {
    const result = harness.service.saveModel({ provider: 'chatgpt' as never })
    expect(result.ok).toBe(false)
    expect(result.errors['provider']).toMatch(/Choose Google API/)
    expect(result.config.model.provider.source).toBe('unset')
  })

  it('rejects a malformed Ollama base URL', () => {
    const result = harness.service.saveModel({ ollamaBaseUrl: 'not-a-url' })
    expect(result.ok).toBe(false)
    expect(result.errors['ollamaBaseUrl']).toMatch(/full URL/)
  })

  it('leaves unmentioned fields untouched on save', () => {
    harness.setEnv({ FLOWLOOM_MODEL_PROVIDER: 'ollama' })
    harness.service.saveModel({ modelId: 'gemma3:4b' })
    const saved = harness.service.saveModel({ ollamaBaseUrl: 'http://127.0.0.1:9999' })
    expect(saved.ok).toBe(true)
    expect(saved.config.model.provider.value).toBe('ollama')
    expect(saved.config.model.provider.source).toBe('env')
    expect(saved.config.model.modelId.value).toBe('gemma3:4b')
    expect(saved.config.model.modelId.source).toBe('settings')
  })

  it('does not silently persist voice/browser fields requested in other sections', () => {
    const result = harness.service.saveVoice({ voiceId: 'voice-abc' })
    expect(result.ok).toBe(true)
    expect(result.config.voice.voiceId.value).toBe('voice-abc')
    expect(result.config.browser.projectId.value).toBe('')
    const browserResult = harness.service.saveBrowser({ projectId: 'proj-1' })
    expect(browserResult.config.browser.projectId.value).toBe('proj-1')
    expect(browserResult.config.voice.voiceId.value).toBe('voice-abc')
  })

  it('persists narration preferences with defaults and validates their bounds', () => {
    const harness = makeService()
    // Defaults: narration off, all categories on, normal speed.
    const defaults = harness.service.describe().voice.narration
    expect(defaults).toEqual({ enabled: false, successes: true, issues: true, browser: true, speed: 1 })

    const result = harness.service.saveVoice({ narrationEnabled: true, narrationSuccesses: false, narrationSpeed: 1.25 })
    expect(result.ok).toBe(true)
    expect(result.config.voice.narration).toEqual({ enabled: true, successes: false, issues: true, browser: true, speed: 1.25 })

    const outOfRange = harness.service.saveVoice({ narrationSpeed: 3 })
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.errors['narrationSpeed']).toMatch(/between/i)

    const notBoolean = harness.service.saveVoice({ narrationEnabled: 'yes' as unknown as boolean })
    expect(notBoolean.ok).toBe(false)
  })

  it('narration preferences survive a settings round-trip through disk', () => {
    const harness = makeService()
    harness.service.saveVoice({ narrationEnabled: true, narrationIssues: false, narrationBrowser: false, narrationSpeed: 0.75 })
    const harness2 = makeService({ reuseDir: harness.dir })
    expect(harness2.service.describe().voice.narration).toEqual({
      enabled: true,
      successes: true,
      issues: false,
      browser: false,
      speed: 0.75
    })
  })

  it('a narration-only save never wipes the stored voice connection test', () => {
    const harness = makeService()
    // Muting during a run saves only narration keys — the persisted
    // real test outcome must survive it untouched.
    harness.service.saveVoice({ narrationEnabled: true, narrationSpeed: 1.25 })
    expect(harness.service.describe().tests.voice).toBeUndefined()
    harness.service.recordTest('voice', {
      status: 'connected',
      code: 'unknown',
      message: 'Connection verified.',
      at: new Date().toISOString(),
      durationMs: 12
    })
    harness.service.saveVoice({ narrationEnabled: false })
    const after = harness.service.describe().tests.voice
    expect(after?.status).toBe('connected')
    expect(after?.message).toBe('Connection verified.')
    // A credential change does still invalidate the old outcome.
    harness.service.saveVoice({ voiceId: 'voice-abc' })
    expect(harness.service.describe().tests.voice).toBeUndefined()
  })
})

describe('secrets handling', () => {
  it('never exposes secret values through the renderer view', () => {
    const harness = makeService()
    const result = harness.service.saveModel({ googleApiKey: 'supersecret-google-key-42' })
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result.config)
    expect(serialized).not.toContain('supersecret-google-key-42')
    expect(result.config.model.googleApiKey.configured).toBe(true)
    expect(result.config.model.googleApiKey.source).toBe('settings')
  })

  it('secret values from .env are also never exposed, only reported as configured', () => {
    const harness = makeService()
    harness.setEnv({ OPENROUTER_API_KEY: 'env-secret-key-9876' })
    const serialized = JSON.stringify(harness.service.describe())
    expect(serialized).not.toContain('env-secret-key-9876')
    expect(harness.service.describe().model.openrouterApiKey.configured).toBe(true)
    expect(harness.service.describe().model.openrouterApiKey.source).toBe('env')
  })

  it('the main process can still read the effective secret for real API calls', () => {
    const harness = makeService()
    harness.setEnv({ ELEVENLABS_API_KEY: 'sk-env-voice' })
    expect(harness.service.getPlainSecret('elevenlabsApiKey')).toBe('sk-env-voice')
    harness.service.saveVoice({ apiKey: 'sk-saved-voice' })
    expect(harness.service.getPlainSecret('elevenlabsApiKey')).toBe('sk-saved-voice')
    // Clearing the override falls back to the env value.
    harness.service.clearOverride('voice.apiKey')
    expect(harness.service.getPlainSecret('elevenlabsApiKey')).toBe('sk-env-voice')
  })

  it('credentials survive a restart through an encrypted-at-rest vault file', () => {
    const harness = makeService()
    const result = harness.service.saveModel({ openrouterApiKey: 'persist-me-key-1' })
    expect(result.ok).toBe(true)

    // A fresh service against the same directory simulates a restart.
    const settings = new JsonStore<PersistedSettings>(
      path.join(harness.dir, 'settings.json'),
      defaultSettings,
      nullLogger()
    )
    const vault = new SecretsVault(path.join(harness.dir, 'secrets.json'), fakeStorage(), nullLogger())
    const restarted = new ConfigService({
      settings,
      env: fakeEnv({}),
      vault,
      logger: nullLogger(),
      secureStorage: fakeStorage(),
      appVersion: 'test',
      platform: 'linux'
    })
    expect(restarted.describe().model.openrouterApiKey.configured).toBe(true)
    expect(restarted.getPlainSecret('openrouterApiKey')).toBe('persist-me-key-1')

    // The raw file must not contain the plaintext credential.
    const raw = fs.readFileSync(path.join(harness.dir, 'secrets.json'), 'utf8')
    expect(raw).not.toContain('persist-me-key-1')
  })

  it('holds credentials in memory only when secure storage is unavailable', () => {
    const harness = makeService({ storage: fakeStorage(false) })
    const result = harness.service.saveModel({ googleApiKey: 'session-only-key-7' })
    expect(result.ok).toBe(true)
    expect(result.config.model.googleApiKey.configured).toBe(true)
    expect(result.config.model.googleApiKey.source).toBe('session')

    // plaintext must not be on disk (in degraded mode the vault file is
    // never even created — both cases are covered here)
    const secretsPath = path.join(harness.dir, 'secrets.json')
    const raw = fs.existsSync(secretsPath) ? fs.readFileSync(secretsPath, 'utf8') : ''
    expect(raw).not.toContain('session-only-key-7')

    // and a "restart" (new vault) no longer has it — honestly unconfigured
    const vault = new SecretsVault(path.join(harness.dir, 'secrets.json'), fakeStorage(false), nullLogger())
    const restarted = new ConfigService({
      settings: new JsonStore<PersistedSettings>(path.join(harness.dir, 'settings.json'), defaultSettings, nullLogger()),
      env: fakeEnv({}),
      vault,
      logger: nullLogger(),
      secureStorage: fakeStorage(false),
      appVersion: 'test',
      platform: 'linux'
    })
    expect(restarted.describe().model.googleApiKey.configured).toBe(false)
  })

  it('never writes credentials back into the .env file', () => {
    const harness = makeService()
    const envFile = path.join(harness.dir, 'user.env')
    fs.writeFileSync(envFile, 'GOOGLE_API_KEY=from-env\n')
    const before = fs.readFileSync(envFile, 'utf8')
    harness.service.saveModel({ googleApiKey: 'never-into-env-key' })
    const after = fs.readFileSync(envFile, 'utf8')
    expect(after).toBe(before)
    expect(after).not.toContain('never-into-env-key')
  })

  it('redacts known secret values from log text', () => {
    const harness = makeService()
    harness.service.saveModel({ googleApiKey: 'logging-leak-target-9' })
    const redactor = harness.service.getRedactor()
    const line = 'Request failed for key logging-leak-target-9 with message x'
    expect(redactor.redact(line)).not.toContain('logging-leak-target-9')
    expect(redactor.redact(line)).toContain('[redacted]')
  })

  it('clears a saved test outcome when its configuration changes', () => {
    const harness = makeService()
    harness.service.recordTest('model', {
      status: 'connected',
      code: 'unknown',
      message: 'Connection verified.',
      at: new Date().toISOString(),
      durationMs: 12
    })
    expect(harness.service.describe().tests.model?.status).toBe('connected')
    harness.service.saveModel({ modelId: 'changed-model' })
    expect(harness.service.describe().tests.model).toBeUndefined()
  })
})
