import type {
  ConnectionTestResult,
  FailureCode,
  SettingsSectionId as SectionId,
  VoiceTestResult
} from '../../shared/contracts'
import type { ConfigService } from '../config/service'
import type { Logger } from '../lib/log'
import { testGoogle } from '../providers/google'
import { testOpenRouter } from '../providers/openrouter'
import { testOllama } from '../providers/ollama'
import { testVoiceConnection, testVoiceGeneration } from '../providers/elevenlabs'
import { testBrowserbase } from '../providers/browserbase'
import { testPaperInstruments, generatePaperCompletion } from '../providers/paperinstruments'
import type { ProviderContext, ProviderTestResult } from '../providers/types'

/**
 * Runs real connection tests in the main process.
 *
 * Rules enforced here:
 * - Nothing is fetched unless every required field for the selected
 *   provider is configured; otherwise the honest result is `unconfigured`.
 * - Tests never switch provider, model, or key as a fallback.
 * - failures are redacted of secret material before anything is persisted
 *   or handed to the renderer.
 * - Duplicate concurrent tests for one section are refused (first call
 *   keeps the ground truth; the UI disables buttons while running anyway).
 */

const MODEL_TIMEOUT_MS = 25_000
const VOICE_TIMEOUT_MS = 30_000
const BROWSER_TIMEOUT_MS = 20_000
const PAPER_TIMEOUT_MS = 30_000

export interface ConnectionTesterDeps {
  config: ConfigService
  logger: Logger
  /** Injectable for unit tests; defaults to global fetch in the app. */
  fetchImpl: typeof globalThis.fetch
}

export class ConnectionTester {
  private readonly inFlight = new Set<SectionId>()

  constructor(private readonly deps: ConnectionTesterDeps) {}

  isRunning(section: SectionId): boolean {
    return this.inFlight.has(section)
  }

  async runModelTest(): Promise<ConnectionTestResult> {
    return this.runOnce('model', () => this.doModelTest())
  }

  async runVoiceTest(): Promise<VoiceTestResult> {
    if (this.inFlight.has('voice')) {
      return voiceFailure('unknown', 'A voice test is already running.')
    }
    this.inFlight.add('voice')
    try {
      const result = await this.doVoiceTest()
      if (result.status === 'failed') {
        this.deps.config.recordTest('voice', {
          status: 'failed',
          code: result.code,
          message: result.message,
          at: result.at,
          durationMs: 0
        })
      } else {
        this.deps.config.recordTest('voice', {
          status: 'connected',
          code: 'unknown',
          message: 'Voice test succeeded.',
          at: result.at,
          durationMs: 0
        })
      }
      return result
    } finally {
      this.inFlight.delete('voice')
    }
  }

  async runBrowserTest(): Promise<ConnectionTestResult> {
    return this.runOnce('browser', () => this.doBrowserTest())
  }

  async runPaperTest(): Promise<ConnectionTestResult> {
    return this.runOnce('paper', () => this.doPaperTest())
  }

  /**
   * A real, minimal generation with the configured model — sent only
   * when the user explicitly asks. Hard-bounded (small prompt, small
   * output budget, lowest reasoning effort) so a single test costs a
   * fraction of a cent at the documented rates. Success proves the full
   * request/response path, not just the credentials.
   */
  async runPaperGenerationTest(): Promise<ConnectionTestResult> {
    return this.runOnce('paper', () => this.doPaperGenerationTest())
  }

  /* ---------------------------------------------------------------- */

  private async runOnce(
    section: SectionId,
    action: () => Promise<ConnectionTestResult>
  ): Promise<ConnectionTestResult> {
    if (this.inFlight.has(section)) {
      const running: ConnectionTestResult = {
        status: 'failed',
        code: 'unknown',
        message: 'A connection test is already running. Wait for it to finish.',
        at: new Date().toISOString(),
        durationMs: 0
      }
      return running
    }
    this.inFlight.add(section)
    const started = Date.now()
    try {
      const raw = await action()
      const redactor = this.deps.config.getRedactor()
      const result: ConnectionTestResult = {
        ...raw,
        message: redactor.redact(raw.message),
        hint: raw.hint ? redactor.redact(raw.hint) : undefined,
        durationMs: Date.now() - started
      }
      if (result.code !== 'unconfigured') {
        this.deps.config.recordTest(section, {
          status: result.status,
          code: result.code,
          message: result.message,
          hint: result.hint,
          at: result.at,
          durationMs: result.durationMs
        })
      } else {
        // An unconfigured status is not a connection outcome; keep any
        // earlier recorded result until a real test runs.
      }
      return result
    } catch (error) {
      this.deps.logger.error('Connection test crashed unexpectedly.', error)
      const crashed: ConnectionTestResult = {
        status: 'failed',
        code: 'unknown',
        message: 'The connection test failed unexpectedly.',
        at: new Date().toISOString(),
        durationMs: Date.now() - started
      }
      this.deps.config.recordTest(section, {
        status: 'failed',
        code: 'unknown',
        message: crashed.message,
        at: crashed.at,
        durationMs: crashed.durationMs
      })
      return crashed
    } finally {
      this.inFlight.delete(section)
    }
  }

  private async doModelTest(): Promise<ConnectionTestResult> {
    const provider = this.deps.config.getEffectiveProvider()
    if (!provider) {
      return unconfigured(
        'Choose a language engine provider and save the settings, or set FLOWLOOM_MODEL_PROVIDER.'
      )
    }
    const modelId = this.deps.config.getEffectiveModelId()
    if (!modelId) {
      return unconfigured('Enter the model ID supplied by your provider before testing.')
    }

    const ctx: ProviderContext = { fetch: this.deps.fetchImpl, timeoutMs: MODEL_TIMEOUT_MS }
    let raw: ProviderTestResult

    if (provider.id === 'google') {
      const apiKey = this.deps.config.getPlainSecret('googleApiKey')
      if (!apiKey) return unconfigured('Add a Google API key in Settings or via GOOGLE_API_KEY.')
      raw = await testGoogle(ctx, { apiKey, modelId })
    } else if (provider.id === 'openrouter') {
      const apiKey = this.deps.config.getPlainSecret('openrouterApiKey')
      if (!apiKey) return unconfigured('Add an OpenRouter API key in Settings or via OPENROUTER_API_KEY.')
      raw = await testOpenRouter(ctx, { apiKey, modelId })
    } else {
      const base = this.deps.config.getEffectiveOllamaBase()
      const apiKey = this.deps.config.getPlainSecret('ollamaApiKey')
      raw = await testOllama(ctx, { baseUrl: base.base, modelId, apiKey })
    }

    this.deps.logger.info(`Model test (${provider.id}) finished with code '${raw.ok ? 'success' : raw.code}'.`)
    return finalize(raw)
  }

  private async doVoiceTest(): Promise<VoiceTestResult> {
    const apiKey = this.deps.config.getPlainSecret('elevenlabsApiKey')
    const voiceId = this.effectiveVoiceId()
    if (!apiKey) {
      return voiceFailure('unconfigured', 'Add an ElevenLabs API key in Settings or via ELEVENLABS_API_KEY.')
    }
    if (!voiceId) {
      return voiceFailure('unconfigured', 'Enter the voice ID supplied by your ElevenLabs account before testing.')
    }
    const ctx: ProviderContext = { fetch: this.deps.fetchImpl, timeoutMs: VOICE_TIMEOUT_MS }

    const authCheck = await testVoiceConnection(ctx, { apiKey })
    if (!authCheck.ok) {
      this.deps.logger.info("Voice connection test failed with code '" + authCheck.code + "'.")
      return finalizeVoice(authCheck)
    }

    const generation = await testVoiceGeneration(ctx, { apiKey, voiceId })
    if (generation.connection) {
      this.deps.logger.info('Voice generation test failed: ' + generation.connection.code)
      return finalizeVoice(generation.connection)
    }
    if (generation.audio) {
      this.deps.logger.info(
        `Voice test succeeded (${generation.audio.base64.length} base64 chars returned).`
      )
      const at = new Date().toISOString()
      return {
        status: 'connected',
        code: 'unknown',
        message: 'Voice verified. Test audio was generated with the supplied voice.',
        audio: {
          mimeType: generation.audio.mimeType,
          base64: generation.audio.base64,
          sizeBytes: Math.floor((generation.audio.base64.length * 3) / 4)
        },
        at
      }
    }
    return voiceFailure('unknown', 'The voice test returned no audio.')
  }

  private async doBrowserTest(): Promise<ConnectionTestResult> {
    const apiKey = this.deps.config.getPlainSecret('browserbaseApiKey')
    if (!apiKey) {
      return unconfigured('Add a Browserbase API key in Settings or via BROWSERBASE_API_KEY.')
    }
    const projectId = this.effectiveBrowserProjectId()
    if (!projectId) {
      return unconfigured('Enter the Browserbase project ID supplied by your account before testing.')
    }
    const ctx: ProviderContext = { fetch: this.deps.fetchImpl, timeoutMs: BROWSER_TIMEOUT_MS }
    const raw = await testBrowserbase(ctx, { apiKey, projectId })
    this.deps.logger.info(`Browser test finished with code '${raw.ok ? 'success' : raw.code}'.`)
    return finalize(raw)
  }

  /**
   * Paper Instruments verification. Free by design: the key is checked
   * with GET /v1/models, the user-supplied model id with GET
   * /v1/models/{id}, and the prepaid balance via GET /v1/usage — none
   * of these generate tokens or session spend. No generation happens
   * unless the user explicitly presses "Test generation".
   */
  private async doPaperTest(): Promise<ConnectionTestResult> {
    const apiKey = this.deps.config.getPlainSecret('paperinstrumentsApiKey')
    if (!apiKey) {
      return unconfigured('Add a Paper Instruments API key in Settings or via PAPERINSTRUMENTS_API_KEY.')
    }
    const modelId = this.deps.config.getEffectivePaperModel()
    if (!modelId) {
      return unconfigured('Enter the exact model ID supplied by your Paper Instruments account before testing.')
    }
    const ctx: ProviderContext = { fetch: this.deps.fetchImpl, timeoutMs: PAPER_TIMEOUT_MS }
    const raw = await testPaperInstruments(ctx, { apiKey, modelId })
    this.deps.logger.info(`Paper Instruments test finished with code '${raw.ok ? 'success' : raw.code}'.`)
    return finalize(raw)
  }

  private async doPaperGenerationTest(): Promise<ConnectionTestResult> {
    const apiKey = this.deps.config.getPlainSecret('paperinstrumentsApiKey')
    if (!apiKey) {
      return unconfigured('Add a Paper Instruments API key in Settings or via PAPERINSTRUMENTS_API_KEY.')
    }
    const modelId = this.deps.config.getEffectivePaperModel()
    if (!modelId) {
      return unconfigured('Enter the exact model ID supplied by your Paper Instruments account before testing.')
    }
    const ctx: ProviderContext = { fetch: this.deps.fetchImpl, timeoutMs: 60_000 }
    const raw = await generatePaperCompletion(ctx, { apiKey }, {
      model: modelId,
      prompt: 'Reply with exactly one word: ready.',
      maxCompletionTokens: 128,
      reasoningEffort: 'low'
    })
    if (!raw.ok) {
      this.deps.logger.info(`Paper Instruments generation test failed with code '${raw.code}'.`)
      return finalize(raw)
    }
    this.deps.logger.info('Paper Instruments generation test succeeded.')
    const tokens = raw.usage
    const usageText = tokens
      ? ` Usage reported by the provider: ${tokens.promptTokens ?? '?'} input + ${tokens.completionTokens ?? '?'} output tokens${tokens.reasoningTokens !== null ? ` (${tokens.reasoningTokens} of them reasoning)` : ''}.`
      : ' The provider did not return usage numbers for this request.'
    const reply = raw.content.trim() === '' ? '(empty reply)' : `"${raw.content.trim().slice(0, 80)}"`
    return {
      status: 'connected',
      code: 'unknown',
      message: `Real generation succeeded in ${raw.durationMs} ms. Reply: ${reply}.${usageText}`,
      at: new Date().toISOString(),
      durationMs: raw.durationMs
    }
  }

  /* ---------------------------------------------------------------- */

  private effectiveVoiceId(): string {
    return this.deps.config.getEffectiveVoiceId()
  }

  private effectiveBrowserProjectId(): string {
    return this.deps.config.getEffectiveBrowserProjectId()
  }
}

function finalize(raw: ProviderTestResult): ConnectionTestResult {
  return {
    status: raw.ok ? 'connected' : 'failed',
    code: raw.code === 'unknown' && raw.ok ? 'unknown' : raw.code,
    message: raw.message,
    hint: raw.hint,
    at: new Date().toISOString(),
    durationMs: 0
  }
}

function finalizeVoice(raw: ProviderTestResult): VoiceTestResult {
  return {
    status: raw.ok ? 'connected' : 'failed',
    code: raw.code,
    message: raw.message,
    at: new Date().toISOString()
  }
}

function unconfigured(message: string): ConnectionTestResult {
  const result = new Date().toISOString()
  return { status: 'failed' as const, code: 'unconfigured', message, at: result, durationMs: 0 }
}

function voiceFailure(code: FailureCode, message: string): VoiceTestResult {
  return { status: 'failed', code, message, at: new Date().toISOString() }
}
