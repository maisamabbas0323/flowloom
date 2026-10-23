import type {
  PlainFieldView,
  ModelProviderId,
  SecretFieldView,
  ValueSource
} from '../../shared/contracts'

/**
 * Pure configuration rules: resolution and validation for the single
 * configuration service. Kept free of Electron and filesystem concerns
 * so they can be unit-tested directly (see tests/main).
 */

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = ['google', 'openrouter', 'ollama']

export function isModelProviderId(value: string): value is ModelProviderId {
  return (MODEL_PROVIDER_IDS as readonly string[]).includes(value)
}

/** Resolves an effective model provider from an override or environment value. */
export function resolveProvider(
  override: string | undefined,
  envValue: string
): { id: ModelProviderId; source: ValueSource } | null {
  // An invalid override never silently falls back — invalid values are
  // treated as unconfigured and the UI explains the problem.
  if (override !== undefined && isModelProviderId(override)) {
    return { id: override, source: 'settings' }
  }
  if (isModelProviderId(envValue)) {
    return { id: envValue, source: 'env' }
  }
  return null
}

/** Resolves an effective plain (non-secret) string field. */
export function resolvePlainField(override: string | undefined, envValue: string): PlainFieldView {
  if (override !== undefined && override !== '') {
    return { value: override, source: 'settings' }
  }
  if (envValue !== '') {
    return { value: envValue, source: 'env' }
  }
  return { value: '', source: 'unset' }
}

/**
 * Ollama base URL falls back to the documented default address of a local
 * Ollama server. Nothing else in the product relies on invented defaults.
 */
export function resolveOllamaBaseUrl(override: string | undefined, envValue: string): PlainFieldView {
  return resolvePlainField(override, envValue) ?? { value: '', source: 'unset' }
}

export function resolveOllamaBaseUrlOrDefault(
  override: string | undefined,
  envValue: string
): PlainFieldView {
  const resolved = resolvePlainField(override, envValue)
  if (resolved.source !== 'unset') return resolved
  return { value: 'http://127.0.0.1:11434', source: 'default' }
}

export function resolveSecretView(
  configured: boolean,
  source: 'settings' | 'session' | 'env' | 'unset',
  updatedAt: string | null
): SecretFieldView {
  return {
    configured,
    source: configured ? source : 'unset',
    updatedAt: configured ? updatedAt : null
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

type SecretFieldValue = string | null | undefined

export interface CleanModelInput {
  provider?: ModelProviderId | null
  modelId?: string | null
  ollamaBaseUrl?: string | null
  googleApiKey?: SecretFieldValue
  openrouterApiKey?: SecretFieldValue
  ollamaApiKey?: SecretFieldValue
}

const MAX_PLAIN_LENGTH = 200

function validateSingleLine(fieldName: string, fieldLabel: string, value: string, errors: Record<string, string>): void {
  if (value.length > MAX_PLAIN_LENGTH) {
    errors[fieldName] = `${fieldLabel} is too long (maximum ${MAX_PLAIN_LENGTH} characters).`
  }
  if (/[\r\n]/.test(value)) {
    errors[fieldName] = `${fieldLabel} must be a single line without line breaks.`
  }
}

function normalizedStringCleared(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export interface ModelParseResult {
  errors: Record<string, string>
  clean: CleanModelInput
}

export function parseModelInput(input: {
  provider?: ModelProviderId | null
  modelId?: string | null
  ollamaBaseUrl?: string | null
  googleApiKey?: string | null
  openrouterApiKey?: string | null
  ollamaApiKey?: string | null
}): ModelParseResult {
  const errors: Record<string, string> = {}
  const clean: CleanModelInput = {}

  if (typeof input.provider === 'string') {
    if (!isModelProviderId(input.provider)) {
      errors.provider = 'Choose Google API, OpenRouter, or Ollama.'
    } else {
      clean.provider = input.provider
    }
  } else if (input.provider === null) {
    clean.provider = null
  }

  const modelId = normalizedStringCleared(input.modelId)
  if (modelId !== undefined) {
    if (modelId !== null) validateSingleLine('modelId', 'Model ID', modelId, errors)
    clean.modelId = modelId
  }

  const ollamaBase = normalizedStringCleared(input.ollamaBaseUrl)
  if (ollamaBase !== undefined && ollamaBase !== null) {
    validateSingleLine('ollamaBaseUrl', 'Ollama base URL', ollamaBase, errors)
    try {
      const url = new URL(ollamaBase)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors['ollamaBaseUrl'] = 'Use a full http:// or https:// URL, e.g. http://127.0.0.1:11434.'
      }
    } catch {
      errors['ollamaBaseUrl'] = 'Use a full URL such as http://127.0.0.1:11434.'
    }
  }
  if (ollamaBase !== undefined) clean.ollamaBaseUrl = ollamaBase

  for (const field of ['googleApiKey', 'openrouterApiKey', 'ollamaApiKey'] as const) {
    const secret = input[field]
    if (secret === undefined) continue
    if (secret === null) {
      clean[field] = null
      continue
    }
    if (typeof secret === 'string' && /[\r\n]/.test(secret)) {
      errors[String(field)] = 'API keys must be a single line without line breaks.'
      continue
    }
    clean[field] = secret
  }

  return { errors, clean }
}

export interface VoiceParseResult {
  errors: Record<string, string>
  clean: {
    voiceId?: string | null
    narrationEnabled?: boolean
    narrationSuccesses?: boolean
    narrationIssues?: boolean
    narrationBrowser?: boolean
    narrationSpeed?: number
  }
}

export const NARRATION_SPEED_MIN = 0.7
export const NARRATION_SPEED_MAX = 1.5

export function parseVoiceInput(input: {
  apiKey?: string | null
  voiceId?: string | null
  narrationEnabled?: boolean
  narrationSuccesses?: boolean
  narrationIssues?: boolean
  narrationBrowser?: boolean
  narrationSpeed?: number
}): VoiceParseResult {
  const errors: Record<string, string> = {}
  const clean: VoiceParseResult['clean'] = {}
  if (typeof input.apiKey === 'string' && /[\r\n]/.test(input.apiKey)) {
    errors['apiKey'] = 'API keys must be a single line without line breaks.'
  }
  const voiceId = normalizedStringCleared(input.voiceId)
  if (voiceId !== undefined) {
    if (voiceId !== null) validateSingleLine('voiceId', 'Voice ID', voiceId, errors)
    clean.voiceId = voiceId
  }
  const booleans: Array<['narrationEnabled' | 'narrationSuccesses' | 'narrationIssues' | 'narrationBrowser', unknown]> = [
    ['narrationEnabled', input.narrationEnabled],
    ['narrationSuccesses', input.narrationSuccesses],
    ['narrationIssues', input.narrationIssues],
    ['narrationBrowser', input.narrationBrowser]
  ]
  for (const [key, value] of booleans) {
    if (typeof value === 'boolean') {
      clean[key] = value
    } else if (typeof value !== 'undefined') {
      errors[key] = 'Choose a boolean value.'
    }
  }
  if (typeof input.narrationSpeed === 'number' && Number.isFinite(input.narrationSpeed)) {
    const speed = Math.round(input.narrationSpeed * 100) / 100
    if (speed < NARRATION_SPEED_MIN || speed > NARRATION_SPEED_MAX) {
      errors['narrationSpeed'] = `The playback speed must be between ${NARRATION_SPEED_MIN} and ${NARRATION_SPEED_MAX}.`
    } else {
      clean.narrationSpeed = speed
    }
  } else if (typeof input.narrationSpeed !== 'undefined') {
    errors['narrationSpeed'] = 'Enter the playback speed as a number.'
  }
  return { errors, clean }
}

export interface PaperParseResult {
  errors: Record<string, string>
  clean: {
    model?: string | null
    enabled?: boolean
    minBalanceUsd?: number
  }
}

/** Hard defaults for the local spending stop (a Settings-only preference). */
export const PAPER_MIN_BALANCE_MIN = 0
export const PAPER_MIN_BALANCE_MAX = 100

/** Rounded to cents — dollar figures below that cannot be represented. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

export function parsePaperInput(input: {
  apiKey?: string | null
  model?: string | null
  enabled?: boolean
  minBalanceUsd?: number
}): PaperParseResult {
  const errors: Record<string, string> = {}
  const clean: PaperParseResult['clean'] = {}
  if (typeof input.apiKey === 'string' && /[\r\n]/.test(input.apiKey)) {
    errors['apiKey'] = 'API keys must be a single line without line breaks.'
  }
  const model = normalizedStringCleared(input.model)
  if (model !== undefined) {
    if (model !== null) validateSingleLine('model', 'Model ID', model, errors)
    const dash = model !== null && /[^a-zA-Z0-9._-]/.test(model)
    if (dash) {
      errors['model'] = 'Model IDs contain letters, numbers, dots, dashes, and underscores only.'
    } else {
      clean.model = model
    }
  }
  if (typeof input.enabled === 'boolean') {
    clean.enabled = input.enabled
  } else if (typeof input.enabled !== 'undefined') {
    errors['enabled'] = 'Choose a boolean value.'
  }
  if (typeof input.minBalanceUsd === 'number' && Number.isFinite(input.minBalanceUsd)) {
    const rounded = roundMoney(input.minBalanceUsd)
    if (rounded < PAPER_MIN_BALANCE_MIN || rounded > PAPER_MIN_BALANCE_MAX) {
      errors['minBalanceUsd'] = `Enter the minimum balance between $${PAPER_MIN_BALANCE_MIN} and $${PAPER_MIN_BALANCE_MAX}.`
    } else {
      clean.minBalanceUsd = rounded
    }
  } else if (typeof input.minBalanceUsd !== 'undefined') {
    errors['minBalanceUsd'] = 'Enter the minimum balance as a dollar amount.'
  }
  return { errors, clean }
}

export interface BrowserParseResult {
  errors: Record<string, string>
  clean: { projectId?: string | null }
}

export function parseBrowserInput(input: { apiKey?: string | null; projectId?: string | null }): BrowserParseResult {
  const errors: Record<string, string> = {}
  const clean: { projectId?: string | null } = {}
  if (typeof input.apiKey === 'string' && /[\r\n]/.test(input.apiKey)) {
    errors['apiKey'] = 'API keys must be a single line without line breaks.'
  }
  const projectId = normalizedStringCleared(input.projectId)
  if (projectId !== undefined) {
    if (projectId !== null) validateSingleLine('projectId', 'Project ID', projectId, errors)
    clean.projectId = projectId
  }
  return { errors, clean }
}

/* ------------------------------------------------------------------ */
/* Clearing saved overrides                                            */
/* ------------------------------------------------------------------ */

import type { SettingsSectionId } from './settingsSchema'
import type { ClearOverrideKey } from '../../shared/contracts'

export function parseGeneralInput(input: { reopenLastWorkflow?: boolean }): Record<string, string> {
  if (typeof input.reopenLastWorkflow !== 'undefined' && typeof input.reopenLastWorkflow !== 'boolean') {
    return { reopenLastWorkflow: 'Choose a boolean value.' }
  }
  return {}
}

export type ClearTarget =
  | { kind: 'override'; overrideKey: 'model.provider' | 'model.modelId' | 'model.ollamaBaseUrl' | 'voice.voiceId' | 'browser.projectId' | 'paper.model'; section: SettingsSectionId }
  | { kind: 'secret'; vaultKey: 'googleApiKey' | 'openrouterApiKey' | 'ollamaApiKey' | 'elevenlabsApiKey' | 'browserbaseApiKey' | 'paperinstrumentsApiKey'; section: SettingsSectionId }

export function clearTarget(key: ClearOverrideKey): ClearTarget {
  switch (key) {
    case 'model.provider':
      return { kind: 'override', overrideKey: 'model.provider', section: 'model' }
    case 'model.modelId':
      return { kind: 'override', overrideKey: 'model.modelId', section: 'model' }
    case 'model.ollamaBaseUrl':
      return { kind: 'override', overrideKey: 'model.ollamaBaseUrl', section: 'model' }
    case 'model.googleApiKey':
      return { kind: 'secret', vaultKey: 'googleApiKey', section: 'model' }
    case 'model.openrouterApiKey':
      return { kind: 'secret', vaultKey: 'openrouterApiKey', section: 'model' }
    case 'model.ollamaApiKey':
      return { kind: 'secret', vaultKey: 'ollamaApiKey', section: 'model' }
    case 'voice.voiceId':
      return { kind: 'override', overrideKey: 'voice.voiceId', section: 'voice' }
    case 'voice.apiKey':
      return { kind: 'secret', vaultKey: 'elevenlabsApiKey', section: 'voice' }
    case 'browser.apiKey':
      return { kind: 'secret', vaultKey: 'browserbaseApiKey', section: 'browser' }
    case 'browser.projectId':
      return { kind: 'override', overrideKey: 'browser.projectId', section: 'browser' }
    case 'paper.apiKey':
      return { kind: 'secret', vaultKey: 'paperinstrumentsApiKey', section: 'paper' }
    case 'paper.model':
      return { kind: 'override', overrideKey: 'paper.model', section: 'paper' }
  }
}

export const SECTIONS_LIST: readonly SettingsSectionId[] = ['model', 'voice', 'browser', 'paper']
