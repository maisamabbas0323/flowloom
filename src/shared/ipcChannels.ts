/**
 * IPC channel names as a dependency-free module.
 *
 * The preload bridge runs with `sandbox: true`, where `require` may load
 * only a tiny allowlist of built-in modules. Keeping the channel names
 * (pure strings) here lets the preload script stay free of module graph
 * baggage — e.g. zod would crash the preload and take the whole bridge
 * down with it — while main and renderer can keep importing the typed
 * contracts module.
 */

export const IPC = {
  configGet: 'config:get',
  configSave: 'config:save',
  configClearOverride: 'config:clear-override',
  configTest: 'config:test',
  configTestVoice: 'config:test-voice',
  /** Paper Instruments: a real, minimal generation, user-initiated only. */
  configTestPaperGeneration: 'config:test-paper-generation',
  systemInfo: 'system:info',
  workflowList: 'workflows:list',
  workflowCreate: 'workflows:create',
  workflowGet: 'workflows:get',
  workflowDelete: 'workflows:delete',
  workflowDuplicate: 'workflows:duplicate',
  workflowSave: 'workflows:save',
  runStart: 'runs:start',
  runCancel: 'runs:cancel',
  runsList: 'runs:list',
  runGet: 'runs:get',
  /** Delete one stored run record (history entry) from disk. */
  runDelete: 'runs:delete',
  /** Clear the entire run history (every stored record). */
  runsClear: 'runs:clear',
  /** Read one app-managed browser artifact (screenshot) by generated id. */
  artifactGet: 'artifacts:get',
  /** Main → renderer push channel for run events (not invokeable). */
  runEvent: 'runs:event',
  /** Main → renderer push channel for narration audio (not invokeable). */
  voiceNarration: 'voice:narration'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
