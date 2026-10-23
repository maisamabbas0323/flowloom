import type { AppConfigView, ModelProviderId } from '../../../../shared/contracts'

/** Status of a settings section as honestly derivable from real data. */
export type SectionStatus = 'unconfigured' | 'untested' | 'testing' | 'connected' | 'failed'

/* ------------------------------------------------------------------ */
/* Status derivation                                                   */
/* ------------------------------------------------------------------ */

export function modelStatus(config: AppConfigView, testing: boolean): { status: SectionStatus; missing: string[] } {
  const missing: string[] = []
  const provider = config.model.provider.value
  if (!provider) {
    missing.push('provider')
    return { status: testing ? 'testing' : 'unconfigured', missing }
  }
  if (!config.model.modelId.value) missing.push('modelId')
  if (provider === 'google' && !config.model.googleApiKey.configured) missing.push('apiKey')
  if (provider === 'openrouter' && !config.model.openrouterApiKey.configured) missing.push('apiKey')

  const last = config.tests.model
  if (testing) return { status: 'testing', missing }
  if (missing.length > 0) return { status: 'unconfigured', missing }
  if (!last) return { status: 'untested', missing }
  return { status: last.status === 'connected' ? 'connected' : 'failed', missing }
}

export function voiceStatus(config: AppConfigView, testing: boolean): SectionStatus {
  const missing = !config.voice.apiKey.configured || !config.voice.voiceId.value
  const last = config.tests.voice
  if (testing) return 'testing'
  if (missing) return 'unconfigured'
  if (!last) return 'untested'
  return last.status === 'connected' ? 'connected' : 'failed'
}

export function browserStatus(config: AppConfigView, testing: boolean): SectionStatus {
  const missing = !config.browser.apiKey.configured || !config.browser.projectId.value
  const last = config.tests.browser
  if (testing) return 'testing'
  if (missing) return 'unconfigured'
  if (!last) return 'untested'
  return last.status === 'connected' ? 'connected' : 'failed'
}

/**
 * Paper Instruments is honestly unconfigured until both the API key and
 * a model id are present — Flowloom never substitutes a model silently.
 */
export function paperStatus(config: AppConfigView, testing: boolean): { status: SectionStatus; missing: string[] } {
  const missing: string[] = []
  if (!config.paper.apiKey.configured) missing.push('API key')
  if (!config.paper.model.value) missing.push('model ID')
  const last = config.tests.paper
  if (testing) return { status: 'testing', missing }
  if (missing.length > 0) return { status: 'unconfigured', missing }
  if (!last) return { status: 'untested', missing }
  return { status: last.status === 'connected' ? 'connected' : 'failed', missing }
}

/* ------------------------------------------------------------------ */
/* Provider metadata                                                   */
/* ------------------------------------------------------------------ */

export const PROVIDER_OPTIONS: Array<{ id: ModelProviderId; name: string; blurb: string; envKeyName: string }> = [
  {
    id: 'google',
    name: 'Google API',
    blurb: 'Google AI (Gemini API) with the exact model ID you supply.',
    envKeyName: 'GOOGLE_API_KEY'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    blurb: 'OpenRouter with the exact model ID you supply.',
    envKeyName: 'OPENROUTER_API_KEY'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    blurb: 'A locally running Ollama server with an installed model tag.',
    envKeyName: 'OLLAMA_API_KEY (optional)'
  }
]
