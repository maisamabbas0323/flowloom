import type {
  AppConfigView,
  BrowserSettingsInput,
  GeneralSettingsInput,
  ModelProviderId,
  ModelSettingsInput,
  PaperSettingsInput,
  SaveResult,
  VoiceConfigView,
  VoiceSettingsInput
} from '../../shared/contracts'
import type { JsonStore } from '../lib/jsonStore'
import { createRedactor, type Logger, type Redactor } from '../lib/log'
import type { EnvSource } from '../env/envSource'
import { SecretsVault, type SecureStorageAdapter } from './vault'
import type { PersistedSettings, PersistedTestResult } from './settingsSchema'
import type { SettingsSectionId } from './settingsSchema'
import {
  clearTarget,
  parseBrowserInput,
  parseGeneralInput,
  parseModelInput,
  parsePaperInput,
  parseVoiceInput,
  resolveOllamaBaseUrlOrDefault,
  resolvePlainField,
  resolveProvider,
  resolveSecretView,
  type ClearTarget
} from './configRules'
import type { ClearOverrideKey } from '../../shared/contracts'
import { isClearOverrideKey } from '../../shared/contracts'
import type { SecretKey, SecretStore } from './secretKeys'

/** Injectable dependencies — replaced with fakes in unit tests. */
export interface ConfigServiceDeps {
  settings: JsonStore<PersistedSettings>
  env: EnvSource
  vault: SecretsVault
  logger: Logger
  secureStorage: SecureStorageAdapter
  appVersion: string
  platform: NodeJS.Platform
  /**
   * The shared secret redactor used by the local developer log; providing
   * it from outside keeps one source of truth for "what counts as secret".
   */
  redactor?: Redactor
}

/**
 * The one configuration system.
 *
 * Resolution policy:
 *   1. A value deliberately saved through Settings wins.
 *   2. Otherwise the corresponding .env value applies.
 *   3. One documented default exists: the Ollama base URL falls back to
 *      http://127.0.0.1:11434 (the standard local Ollama address).
 *   4. Anything else without a source is unconfigured.
 *
 * Clearing a saved override immediately exposes the .env value again.
 * Only plain (non-secret) values leave this service; credentials stay in
 * the vault and reach the renderer only as configured/source metadata.
 * Saves never write credentials back into the .env file.
 */
export class ConfigService {
  private readonly redactor: Redactor
  /**
   * Config-change listeners so derived state (the UI) can stay honest when
   * saved configuration changes.
   */
  private listeners: Array<(config: AppConfigView) => void> = []

  constructor(private readonly deps: ConfigServiceDeps) {
    this.redactor = deps.redactor ?? createRedactor()
    this.refreshRedactorSecrets()
  }

  /** Subscribes to effective-configuration changes; returns an unsubscriber. */
  onChange(listener: (config: AppConfigView) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Effective values (main-process use: provider tests, future runs)  */
  /* ---------------------------------------------------------------- */

  private envValue(key: string): string {
    return this.deps.env.read()[key] ?? ''
  }

  getEffectiveProvider(): { id: ModelProviderId; source: string } | null {
    return resolveProvider(
      this.deps.settings.read().overrides['model.provider'],
      this.envValue('FLOWLOOM_MODEL_PROVIDER')
    )
  }

  getEffectiveModelId(): string {
    return resolvePlainField(
      this.deps.settings.read().overrides['model.modelId'],
      this.envValue('FLOWLOOM_MODEL_ID')
    ).value
  }

  getEffectiveOllamaBase(): { base: string; source: string } {
    const resolved = resolveOllamaBaseUrlOrDefault(
      this.deps.settings.read().overrides['model.ollamaBaseUrl'],
      this.envValue('OLLAMA_BASE_URL')
    )
    return { base: resolved.value, source: resolved.source }
  }

  getEffectiveVoiceId(): string {
    return resolvePlainField(
      this.deps.settings.read().overrides['voice.voiceId'],
      this.envValue('ELEVENLABS_VOICE_ID')
    ).value
  }

  /**
   * Narration preferences with their defaults. These are Settings-only
   * (no .env counterpart) and never contain secrets.
   */
  getNarrationSettings(): {
    enabled: boolean
    successes: boolean
    issues: boolean
    browser: boolean
    speed: number
  } {
    const overrides = this.deps.settings.read().overrides
    const bool = (
      key: 'voice.narrationEnabled' | 'voice.narrationSuccesses' | 'voice.narrationIssues' | 'voice.narrationBrowser',
      fallback: boolean
    ): boolean => (typeof overrides[key] === 'boolean' ? (overrides[key] as boolean) : fallback)
    const rawSpeed = overrides['voice.narrationSpeed']
    const speed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
        ? Math.min(1.5, Math.max(0.7, rawSpeed))
        : 1
    return {
      enabled: bool('voice.narrationEnabled', false),
      successes: bool('voice.narrationSuccesses', true),
      issues: bool('voice.narrationIssues', true),
      browser: bool('voice.narrationBrowser', true),
      speed
    }
  }

  private narrationView(): VoiceConfigView['narration'] {
    const values = this.getNarrationSettings()
    return { ...values }
  }

  getEffectiveBrowserProjectId(): string {
    return resolvePlainField(
      this.deps.settings.read().overrides['browser.projectId'],
      this.envValue('BROWSERBASE_PROJECT_ID')
    ).value
  }

  /** The user-supplied Paper Instruments model id (Settings or .env). */
  getEffectivePaperModel(): string {
    return resolvePlainField(
      this.deps.settings.read().overrides['paper.model'],
      this.envValue('PAPERINSTRUMENTS_MODEL')
    ).value
  }

  /**
   * Paper Instruments toggle: on unless the user deliberately switched it
   * off. When off, generation-capable steps refuse before any request.
   */
  getPaperEnabled(): boolean {
    return this.deps.settings.read().overrides['paper.enabled'] !== false
  }

  /** The local spending stop in dollars; 0 disables the pre-call check. */
  getPaperMinBalanceUsd(): number {
    const raw = this.deps.settings.read().overrides['paper.minBalanceUsd']
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.min(100, Math.max(0, Math.round(raw * 100) / 100))
    }
    return 0
  }

  getPlainSecret(key: SecretKey): string | null {    const vaultKey: SecretKey = key
    const fromVault = this.deps.vault.getSecret(vaultKey)
    if (fromVault) return fromVault.value
    const envMap: Record<string, string> = {
      googleApiKey: 'GOOGLE_API_KEY',
      openrouterApiKey: 'OPENROUTER_API_KEY',
      ollamaApiKey: 'OLLAMA_API_KEY',
      elevenlabsApiKey: 'ELEVENLABS_API_KEY',
      browserbaseApiKey: 'BROWSERBASE_API_KEY',
      paperinstrumentsApiKey: 'PAPERINSTRUMENTS_API_KEY'
    }
    return this.envValue(envMap[key]) || null
  }

  /* ---------------------------------------------------------------- */
  /* Renderer view (sanitized by construction — no secret values)       */
  /* ---------------------------------------------------------------- */

  describe(): AppConfigView {
    const settings = this.deps.settings.read()
    const isEncryptedAtRest = this.deps.secureStorage.isAvailable()
    const secret = (key: SecretKey, envKey: string): AppConfigView['model']['googleApiKey'] => {
      const fromVault = this.deps.vault.getSecret(key)
      if (fromVault) {
        return resolveSecretView(true, isEncryptedAtRest ? 'settings' : 'session', fromVault.updatedAt)
      }
      return resolveSecretView(this.envValue(envKey) !== '', 'env', null)
    }
    return {
      model: {
        provider: resolvePlainField(
          settings.overrides['model.provider'],
          this.envValue('FLOWLOOM_MODEL_PROVIDER')
        ),
        modelId: resolvePlainField(
          settings.overrides['model.modelId'],
          this.envValue('FLOWLOOM_MODEL_ID')
        ),
        googleApiKey: secret('googleApiKey', 'GOOGLE_API_KEY'),
        openrouterApiKey: secret('openrouterApiKey', 'OPENROUTER_API_KEY'),
        ollamaBaseUrl: resolveOllamaBaseUrlOrDefault(
          settings.overrides['model.ollamaBaseUrl'],
          this.envValue('OLLAMA_BASE_URL')
        ),
        ollamaApiKey: secret('ollamaApiKey', 'OLLAMA_API_KEY')
      },
      voice: {
        apiKey: secret('elevenlabsApiKey', 'ELEVENLABS_API_KEY'),
        voiceId: resolvePlainField(
          settings.overrides['voice.voiceId'],
          this.envValue('ELEVENLABS_VOICE_ID')
        ),
        narration: this.narrationView()
      },
      browser: {
        apiKey: secret('browserbaseApiKey', 'BROWSERBASE_API_KEY'),
        projectId: resolvePlainField(
          settings.overrides['browser.projectId'],
          this.envValue('BROWSERBASE_PROJECT_ID')
        )
      },
      paper: {
        apiKey: secret('paperinstrumentsApiKey', 'PAPERINSTRUMENTS_API_KEY'),
        model: resolvePlainField(
          settings.overrides['paper.model'],
          this.envValue('PAPERINSTRUMENTS_MODEL')
        ),
        preferences: {
          enabled: this.getPaperEnabled(),
          minBalanceUsd: this.getPaperMinBalanceUsd()
        }
      },
      general: {
        reopenLastWorkflow: {
          enabled: settings.overrides['general.reopenLastWorkflow'] === true,
          source: 'settings'
        }
      },
      capabilities: {
        secureStorageAvailable: isEncryptedAtRest,
        envFilePath: this.deps.env.getPath(),
        platform: this.deps.platform,
        appVersion: this.deps.appVersion
      },
      tests: {
        model: settings.lastTests['model'] ?? undefined,
        voice: settings.lastTests['voice'] ?? undefined,
        browser: settings.lastTests['browser'] ?? undefined,
        paper: settings.lastTests['paper'] ?? undefined
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Saved overrides                                                   */
  /* ---------------------------------------------------------------- */

  saveModel(input: ModelSettingsInput): SaveResult {
    const { errors, clean } = parseModelInput(input)
    if (Object.keys(errors).length > 0) return this.reject(errors)
    this.applyVault('googleApiKey', clean.googleApiKey)
    this.applyVault('openrouterApiKey', clean.openrouterApiKey)
    this.applyVault('ollamaApiKey', clean.ollamaApiKey)
    const patch: Partial<Record<'model.provider' | 'model.modelId' | 'model.ollamaBaseUrl', string | null>> = {}
    if (clean.provider !== undefined) patch['model.provider'] = clean.provider
    if (clean.modelId !== undefined) patch['model.modelId'] = clean.modelId
    if (clean.ollamaBaseUrl !== undefined) patch['model.ollamaBaseUrl'] = clean.ollamaBaseUrl
    this.applyOverrides(patch)
    this.clearLastTest('model')
    this.refreshRedactorSecrets()
    return this.accept()
  }

  saveVoice(input: VoiceSettingsInput): SaveResult {
    const { errors, clean } = parseVoiceInput(input)
    if (Object.keys(errors).length > 0) return this.reject(errors)
    this.applyVault('elevenlabsApiKey', input.apiKey === undefined ? undefined : input.apiKey)
    if (clean.voiceId !== undefined) this.setOverride('voice.voiceId', clean.voiceId)
    this.applyOverrides({
      'voice.narrationEnabled': clean.narrationEnabled,
      'voice.narrationSuccesses': clean.narrationSuccesses,
      'voice.narrationIssues': clean.narrationIssues,
      'voice.narrationBrowser': clean.narrationBrowser,
      'voice.narrationSpeed': clean.narrationSpeed
    })
    // Only a credential change invalidates a stored connection-test
    // outcome. Narration preferences (e.g. muting during a run) must
    // leave the last real test result untouched.
    const credentialChanged = input.apiKey !== undefined || clean.voiceId !== undefined
    if (credentialChanged) this.clearLastTest('voice')
    this.refreshRedactorSecrets()
    return this.accept()
  }

  saveBrowser(input: BrowserSettingsInput): SaveResult {
    const { errors, clean } = parseBrowserInput(input)
    if (Object.keys(errors).length > 0) return this.reject(errors)
    this.applyVault('browserbaseApiKey', input.apiKey === undefined ? undefined : input.apiKey)
    if (clean.projectId !== undefined) this.setOverride('browser.projectId', clean.projectId)
    this.clearLastTest('browser')
    this.refreshRedactorSecrets()
    return this.accept()
  }

  /**
   * Paper Instruments settings. As with voice, a credential/model change
   * invalidates the stored connection-test outcome, but the local
   * preferences (enable toggle, spending stop) leave it untouched —
   * they do not change what the last real test verified.
   */
  savePaper(input: PaperSettingsInput): SaveResult {
    const { errors, clean } = parsePaperInput(input)
    if (Object.keys(errors).length > 0) return this.reject(errors)
    this.applyVault('paperinstrumentsApiKey', input.apiKey === undefined ? undefined : input.apiKey)
    if (clean.model !== undefined) this.setOverride('paper.model', clean.model)
    this.applyOverrides({
      'paper.enabled': clean.enabled,
      'paper.minBalanceUsd': clean.minBalanceUsd
    })
    const credentialChanged = input.apiKey !== undefined || clean.model !== undefined
    if (credentialChanged) this.clearLastTest('paper')
    this.refreshRedactorSecrets()
    return this.accept()
  }

  saveGeneral(input: GeneralSettingsInput): SaveResult {
    const errors = parseGeneralInput(input)
    if (Object.keys(errors).length > 0) return this.reject(errors)
    this.deps.settings.update((prev) => {
      if (input.reopenLastWorkflow !== undefined) {
        prev.overrides['general.reopenLastWorkflow'] = input.reopenLastWorkflow
      }
      return prev
    })
    this.deps.logger.info('General preferences saved.')
    return this.accept()
  }

  /**
   * Removes a saved override (Settings wins → unset) so the .env value
   * becomes effective again. Never modifies the .env file itself.
   */
  clearOverride(key: ClearOverrideKey): SaveResult {
    if (!isClearOverrideKey(key)) return this.reject({ general: 'Unknown setting.' })
    const target: ClearTarget = clearTarget(key)
    if (target.kind === 'override') {
      this.deps.settings.update((prev) => {
        delete prev.overrides[target.overrideKey]
        return prev
      })
      this.deps.logger.info(`Cleared saved override '${key}' — the environment value (if any) is effective again.`)
      this.clearLastTest(target.section)
      return this.accept()
    }
    this.deps.vault.clearSecret(target.vaultKey)
    this.deps.logger.info(`Cleared saved credential override '${key}'.`)
    this.clearLastTest(target.section)
    this.refreshRedactorSecrets()
    return this.accept()
  }

  /* ---------------------------------------------------------------- */
  /* Connection-test bookkeeping                                       */
  /* ---------------------------------------------------------------- */

  getLastTest(section: SettingsSectionId): PersistedTestResult | null {
    return this.deps.settings.read().lastTests[section] ?? null
  }

  recordTest(section: SettingsSectionId, result: PersistedTestResult | null): void {
    this.deps.settings.update((prev) => {
      if (result === null) delete prev.lastTests[section]
      else prev.lastTests[section] = result
      return prev
    })
  }

  private clearLastTest(section: SettingsSectionId): void {
    if (this.getLastTest(section)) this.recordTest(section, null)
  }

  /* ---------------------------------------------------------------- */
  /* Log redaction                                                     */
  /* ---------------------------------------------------------------- */

  refreshRedactorSecrets(): void {
    const secrets: string[] = []
    for (const key of ['googleApiKey', 'openrouterApiKey', 'ollamaApiKey', 'elevenlabsApiKey', 'browserbaseApiKey', 'paperinstrumentsApiKey'] as const) {
      const entry = this.deps.vault.getSecret(key)
      if (entry) secrets.push(entry.value)
    }
    const env = this.deps.env.read()
    for (const envKey of ['GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_API_KEY', 'ELEVENLABS_API_KEY', 'BROWSERBASE_API_KEY', 'PAPERINSTRUMENTS_API_KEY']) {
      const value = env[envKey]
      if (value) secrets.push(value)
    }
    this.redactor.setSecrets(secrets)
  }

  getRedactor(): Redactor {
    return this.redactor
  }

  /* ---------------------------------------------------------------- */

  private accept(): SaveResult {
    const config = this.describe()
    this.notify(config)
    return { ok: true, errors: {}, config }
  }

  private reject(errors: Record<string, string>): SaveResult {
    return { ok: false, errors, config: this.describe() }
  }

  /** Sets a single non-secret override; null/empty clears it back to .env. */
  private setOverride(
    key: 'model.provider' | 'model.modelId' | 'model.ollamaBaseUrl' | 'voice.voiceId' | 'browser.projectId' | 'paper.model',
    value: string | null
  ): void {
    if (value === null) {
      this.applyOverrides({ [key]: null })
      return
    }
    const trimmed = value.trim()
    if (trimmed === '') {
      this.applyOverrides({ [key]: null })
    } else {
      this.applyOverrides({ [key]: trimmed })
    }
  }

  private applyOverrides(
    patch: Partial<Record<keyof PersistedSettings['overrides'], string | boolean | number | null | undefined>>
  ): void {
    if (Object.keys(patch).filter((k) => patch[k as keyof PersistedSettings['overrides']] !== undefined).length === 0) {
      return
    }
    this.deps.settings.update((prev) => {
      for (const [key, value] of Object.entries(patch)) {
        const typedKey = key as keyof PersistedSettings['overrides']
        if (value === null) delete prev.overrides[typedKey]
        else if (value !== undefined) prev.overrides[typedKey] = value as never
      }
      return prev
    })
  }

  /**
   * Saves or clears a credential override through the vault.
   * `undefined` leaves the field untouched; null or an empty string clears.
   */
  private applyVault(key: SecretKey, value: string | null | undefined): void {
    if (value === undefined) return
    const trimmed = value === null ? null : value.trim()
    if (trimmed === null || trimmed === '') {
      this.deps.vault.clearSecret(key)
      this.deps.logger.info(`Cleared credential override '${key}'.`)
      return
    }
    const persisted: SecretStore = this.deps.vault.setSecret(key, trimmed)
    this.deps.logger.info(
      persisted === 'disk'
        ? `Credential override '${key}' saved with OS secure storage.`
        : `Credential override '${key}' held in memory only (secure storage unavailable).`
    )
  }

  /* Config-change listeners: the UI can keep derived state honest. */
  private notify(config: AppConfigView): void {
    for (const listener of this.listeners) listener(config)
  }
}
