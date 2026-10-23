/**
 * Flowloom shared contracts.
 * Types and channel names used by the main process, the preload bridge,
 * and the renderer. The renderer receives only sanitized configuration
 * views — secret values never cross the IPC boundary in plaintext.
 */

import type { WorkflowNode, WorkflowEdge } from './nodeSchema'

export const APP_NAME = 'Flowloom'
export const APP_TAGLINE = 'Connect it once. Let it run.'

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export type ModelProviderId = 'google' | 'openrouter' | 'ollama'

/** Where an effective configuration value comes from. */
export type ValueSource =
  | 'settings' // saved through the in-app Settings screen
  | 'env' // the .env file (or OS environment when the file is absent)
  | 'default' // a documented built-in default
  | 'unset'

/** A non-secret, effective value as seen by the renderer. */
export interface PlainFieldView {
  value: string
  source: ValueSource
}

/**
 * A secret as seen by the renderer. Never contains the secret itself —
 * only whether one is configured, from which source, and when it was set.
 * Note: `source: 'session'` means the credential is held in memory only
 * because secure OS storage is unavailable.
 */
export interface SecretFieldView {
  configured: boolean
  source: ValueSource | 'session'
  updatedAt: string | null
}

export interface LanguageEngineConfigView {
  provider: PlainFieldView
  modelId: PlainFieldView
  googleApiKey: SecretFieldView
  openrouterApiKey: SecretFieldView
  ollamaBaseUrl: PlainFieldView
  ollamaApiKey: SecretFieldView
}

export interface VoiceConfigView {
  apiKey: SecretFieldView
  voiceId: PlainFieldView
  /** Narration preferences (Settings-only; no .env counterpart). */
  narration: {
    enabled: boolean
    successes: boolean
    issues: boolean
    browser: boolean
    /** Playback rate of generated narration audio (0.7–1.5). */
    speed: number
  }
}

export interface BrowserAutomationConfigView {
  apiKey: SecretFieldView
  projectId: PlainFieldView
}

/** Paper Instruments (Ultramarine API) as seen by the renderer. */
export interface PaperInstrumentsConfigView {
  apiKey: SecretFieldView
  model: PlainFieldView
  /** Settings-only preferences (no .env counterpart), never secrets. */
  preferences: {
    /** Turn off to make every Paper Instruments workflow step refuse to run. */
    enabled: boolean
    /**
     * Local spending stop: refuses generation when the prepaid balance
     * reported by the provider is below this dollar figure. 0 disables it.
     */
    minBalanceUsd: number
  }
}

export interface GeneralConfigView {
  /** Reopen the most recently opened workflow when the app starts. */
  reopenLastWorkflow: {
    enabled: boolean
    source: ValueSource
  }
}

/** Runtime capabilities that affect what Settings can honestly offer. */
export interface CapabilityView {
  /** OS-backed secure storage (Electron safeStorage) is available. */
  secureStorageAvailable: boolean
  /** .env file found and loaded from this absolute path; null when absent. */
  envFilePath: string | null
  platform: string
  appVersion: string
}

export interface AppConfigView {
  model: LanguageEngineConfigView
  voice: VoiceConfigView
  browser: BrowserAutomationConfigView
  paper: PaperInstrumentsConfigView
  general: GeneralConfigView
  capabilities: CapabilityView
  /** Outcome of the latest real connection test per section (never fake). */
  tests: {
    model?: TestRecord
    voice?: TestRecord
    browser?: TestRecord
    paper?: TestRecord
  }
}

/** A persisted, real connection-test outcome. */
export interface TestRecord {
  status: 'connected' | 'failed'
  code: FailureCode
  message: string
  hint?: string
  at: string
  durationMs: number
}

/* ------------------------------------------------------------------ */
/* Settings mutations                                                  */
/* ------------------------------------------------------------------ */

/**
 * `undefined` leaves a field untouched, a string saves a new override,
 * and `null` clears a saved override so the .env value becomes effective
 * again. This is the single documented way overrides are managed.
 */
export interface ModelSettingsInput {
  provider?: ModelProviderId | null
  modelId?: string | null
  googleApiKey?: string | null
  openrouterApiKey?: string | null
  ollamaBaseUrl?: string | null
  ollamaApiKey?: string | null
}

export interface VoiceSettingsInput {
  apiKey?: string | null
  voiceId?: string | null
  narrationEnabled?: boolean
  narrationSuccesses?: boolean
  narrationIssues?: boolean
  narrationBrowser?: boolean
  narrationSpeed?: number
}

export interface BrowserSettingsInput {
  apiKey?: string | null
  projectId?: string | null
}

export interface PaperSettingsInput {
  apiKey?: string | null
  model?: string | null
  enabled?: boolean
  minBalanceUsd?: number
}

export interface GeneralSettingsInput {
  reopenLastWorkflow?: boolean
}

export type SettingsSectionId = 'model' | 'voice' | 'browser' | 'paper'

/**
 * Keys whose saved Settings override can be cleared by the user, making
 * the .env value (if any) effective again. Deliberately a fixed union.
 */
export type ClearOverrideKey =
  | 'model.provider'
  | 'model.modelId'
  | 'model.ollamaBaseUrl'
  | 'model.googleApiKey'
  | 'model.openrouterApiKey'
  | 'model.ollamaApiKey'
  | 'voice.voiceId'
  | 'voice.apiKey'
  | 'browser.apiKey'
  | 'browser.projectId'
  | 'paper.apiKey'
  | 'paper.model'

const CLEAR_OVERRIDE_KEYS: readonly string[] = [
  'model.provider',
  'model.modelId',
  'model.ollamaBaseUrl',
  'model.googleApiKey',
  'model.openrouterApiKey',
  'model.ollamaApiKey',
  'voice.voiceId',
  'voice.apiKey',
  'browser.apiKey',
  'browser.projectId',
  'paper.apiKey',
  'paper.model'
]

export function isClearOverrideKey(value: string): value is ClearOverrideKey {
  return CLEAR_OVERRIDE_KEYS.includes(value)
}

export interface SaveResult {
  ok: boolean
  errors: Record<string, string>
  config: AppConfigView
}

/* ------------------------------------------------------------------ */
/* Connection testing                                                  */
/* ------------------------------------------------------------------ */

export type FailureCode =
  | 'unconfigured' // required fields are missing — no network call attempted
  | 'auth' // the server rejected the credentials
  | 'model_not_found' // the provider does not serve the supplied model id
  | 'voice_not_found' // the supplied voice id is unknown or inaccessible
  | 'invalid_target' // e.g. malformed Ollama base URL
  | 'server_unreachable' // could not connect to the server at all
  | 'rate_limit'
  | 'insufficient_credit' // the provider reports the prepaid balance cannot cover the request
  | 'invalid_response' // a structured response could not be parsed or validated
  | 'server_error' // the provider reported a 5xx-class problem
  | 'timeout'
  | 'cleanup_warning' // test succeeded but cleanup could not be confirmed
  | 'unknown'

export type ConnectionStatus = 'unconfigured' | 'testing' | 'connected' | 'failed'

export interface ConnectionTestResult {
  status: 'connected' | 'failed'
  code: FailureCode
  /** Short, human-readable summary safe for the UI. Secrets are redacted. */
  message: string
  /**
   * Optional non-secret diagnostic hint. Technical provider details stay in
   * the local developer log; this must never contain credential material.
   */
  hint?: string
  at: string
  durationMs: number
}

export interface VoiceTestResult {
  status: 'connected' | 'failed'
  code: FailureCode
  message: string
  /** Audio returned by the provider, offered to the renderer for playback. */
  audio?: {
    mimeType: string
    base64: string
    sizeBytes: number
  }
  at: string
}

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

/** The renderer builds and edits this graph; the code lives in src/shared/nodeSchema.ts. */
export interface WorkflowGraph {
  schemaVersion: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowRecord {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
  graph: WorkflowGraph
  /**
   * Saved canvas view (zoom + pan) so reopening shows the workflow
   * exactly as the user left it; null until the view has been captured.
   */
  view?: { zoom: number; x: number; y: number } | null
}

export interface WorkflowSummary {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

/**
 * Persistence outcome from the main process. Structural validation
 * failures arrive as `errors`; complete-but-unfinished configuration is
 * accepted and reported separately so the editor can flag it honestly.
 */
export type WorkflowSaveResult =
  | { ok: true; record: WorkflowRecord; configIssues: Array<{ nodeId: string; message: string }> }
  | { ok: false; errors: string[] }

export type {
  WorkflowNode,
  WorkflowEdge,
  NodeTypeId,
  NodeCreationTemplate,
  GraphValidationIssue,
  GraphValidationResult
} from './nodeSchema'

export type {
  RunStatus,
  NodeRunStatus,
  RunRecord,
  RunSummary,
  RunEvent,
  NarrationPayload,
  RunStartResult
} from './runTypes'

/* ------------------------------------------------------------------ */
/* IPC channels                                                        */
/* ------------------------------------------------------------------ */

/** Channel names live in `ipcChannels.ts` (preload must stay dependency-free). */
export { IPC, type IpcChannel } from './ipcChannels'
