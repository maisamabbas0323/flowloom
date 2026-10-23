import type {
  AppConfigView,
  BrowserSettingsInput,
  ClearOverrideKey,
  ConnectionTestResult,
  GeneralSettingsInput,
  ModelSettingsInput,
  PaperSettingsInput,
  RunEvent,
  NarrationPayload,
  RunRecord,
  RunStartResult,
  RunSummary,
  SaveResult,
  SettingsSectionId,
  VoiceSettingsInput,
  VoiceTestResult,
  WorkflowGraph,
  WorkflowRecord,
  WorkflowSaveResult,
  WorkflowSummary
} from '../shared/contracts'

/** The typed API the preload bridge exposes to the renderer. */
export interface FlowloomApi {
  getConfig(): Promise<AppConfigView>
  saveModelSettings(input: ModelSettingsInput): Promise<SaveResult>
  saveVoiceSettings(input: VoiceSettingsInput): Promise<SaveResult>
  saveBrowserSettings(input: BrowserSettingsInput): Promise<SaveResult>
  savePaperSettings(input: PaperSettingsInput): Promise<SaveResult>
  saveGeneralSettings(input: GeneralSettingsInput): Promise<SaveResult>
  clearOverride(key: ClearOverrideKey): Promise<SaveResult>
  testConnection(section: SettingsSectionId): Promise<ConnectionTestResult | VoiceTestResult>
  /** Dedicated voice test — may return generated sample audio. */
  testVoice(): Promise<VoiceTestResult>
  /** Paper Instruments: user-initiated minimal real generation (billable). */
  testPaperGeneration(): Promise<ConnectionTestResult>
  getSystemInfo(): Promise<{
    platform: string
    appVersion: string
    secureStorageAvailable: boolean
    envFilePath: string | null
  }>

  listWorkflows(): Promise<WorkflowSummary[]>
  createWorkflow(input: { name: string }): Promise<WorkflowRecord | null>
  getWorkflow(id: string): Promise<WorkflowRecord | null>
  /**
   * Persists the whole graph. The main process validates it again and
   * reports structural errors, or success with per-node notes about
   * still-missing configuration.
   */
  saveWorkflow(input: {
    id: string
    name: string
    description?: string
    graph: WorkflowGraph
    view?: { zoom: number; x: number; y: number } | null
  }): Promise<WorkflowSaveResult>
  duplicateWorkflow(id: string): Promise<WorkflowRecord | null>
  deleteWorkflow(id: string): Promise<boolean>

  /* workflow execution ------------------------------------------------ */

  /**
   * Starts a run of a *persisted* workflow. The plan is built in the
   * main process from disk data; validation problems come back as
   * actionable errors, and the run id is returned on success.
   */
  startRun(workflowId: string): Promise<RunStartResult>
  /** Requests cancellation of an active run. */
  cancelRun(runId: string): Promise<boolean>
  /** Newest-first summary of persisted runs. */
  listRuns(): Promise<RunSummary[]>
  /** Full node-level record for the run detail view (null if unavailable). */
  getRun(runId: string): Promise<RunRecord | null>
  /** Deletes one stored run record. True when it existed and was removed. */
  deleteRun(runId: string): Promise<boolean>
  /** Clears the entire run history. Returns the number of records removed. */
  clearRunHistory(): Promise<number>
  /**
   * Subscribes to live execution events. Returns an unsubscribe
   * function so repeated mounts never accumulate duplicate listeners.
   */
  onRunEvent(listener: (event: RunEvent) => void): () => void
  /**
   * Subscribes to optional voice-narration pushes (real generated
   * audio from the main process). Returns an unsubscribe function.
   */
  onNarration(listener: (payload: NarrationPayload) => void): () => void

  /**
   * Reads one app-managed artifact by its generated id (screenshots).
   * The main process only serves well-formed ids from its own storage —
   * no filesystem access is exposed to the renderer.
   */
  getArtifact(artifactId: string): Promise<{ id: string; mimeType: string; base64: string } | null>
}

declare global {
  interface Window {
    flowloom: FlowloomApi
  }
}
