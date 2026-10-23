import type { TestRecord } from '../../shared/contracts'

/**
 * Non-secret application settings persisted in the OS application
 * configuration directory (userData). Credentials are NOT stored here —
 * they live in the encrypted vault (or session memory only).
 */
export type PersistedTestResult = TestRecord

export interface PersistedSettings {
  version: 1
  overrides: {
    'model.provider'?: string
    'model.modelId'?: string
    'model.ollamaBaseUrl'?: string
    'voice.voiceId'?: string
    'voice.narrationEnabled'?: boolean
    'voice.narrationSuccesses'?: boolean
    'voice.narrationIssues'?: boolean
    'voice.narrationBrowser'?: boolean
    'voice.narrationSpeed'?: number
    'browser.projectId'?: string
    'paper.model'?: string
    'paper.enabled'?: boolean
    'paper.minBalanceUsd'?: number
    'general.reopenLastWorkflow'?: boolean
  }
  /** Outcome of the latest *real* connection test per section. */
  lastTests: {
    model?: PersistedTestResult
    voice?: PersistedTestResult
    browser?: PersistedTestResult
    paper?: PersistedTestResult
  }
}

export type SettingsSectionId = 'model' | 'voice' | 'browser' | 'paper'

export const TEST_SECTIONS: readonly SettingsSectionId[] = ['model', 'voice', 'browser', 'paper']

export function defaultSettings(): PersistedSettings {
  return { version: 1, overrides: {}, lastTests: {} }
}
