import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcChannels'
import type { FlowloomApi } from './api'
import type { RunEvent, NarrationPayload } from '../shared/runTypes'
/**
 * Preload bridge — a small, explicitly typed API surface.
 *
 * Only the narrow methods below are exposed: no arbitrary channel
 * invocation, no filesystem, no process access. Secret values are never
 * part of any exposed return type (see contracts.ts).
 */

const api: FlowloomApi = {
  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  saveModelSettings: (input) => ipcRenderer.invoke(IPC.configSave, 'model', input),
  saveVoiceSettings: (input) => ipcRenderer.invoke(IPC.configSave, 'voice', input),
  saveBrowserSettings: (input) => ipcRenderer.invoke(IPC.configSave, 'browser', input),
  savePaperSettings: (input) => ipcRenderer.invoke(IPC.configSave, 'paper', input),
  saveGeneralSettings: (input) => ipcRenderer.invoke(IPC.configSave, 'general', input),
  clearOverride: (key) => ipcRenderer.invoke(IPC.configClearOverride, key),
  testConnection: (section) => ipcRenderer.invoke(IPC.configTest, section),
  testVoice: () => ipcRenderer.invoke(IPC.configTestVoice),
  /** Paper Instruments: user-initiated minimal real generation. */
  testPaperGeneration: () => ipcRenderer.invoke(IPC.configTestPaperGeneration),
  getSystemInfo: () => ipcRenderer.invoke(IPC.systemInfo),
  listWorkflows: () => ipcRenderer.invoke(IPC.workflowList),
  createWorkflow: (input) => ipcRenderer.invoke(IPC.workflowCreate, input),
  getWorkflow: (id) => ipcRenderer.invoke(IPC.workflowGet, id),
  saveWorkflow: (input) => ipcRenderer.invoke(IPC.workflowSave, input),
  duplicateWorkflow: (id) => ipcRenderer.invoke(IPC.workflowDuplicate, id),
  deleteWorkflow: (id) => ipcRenderer.invoke(IPC.workflowDelete, id),
  startRun: (workflowId) => ipcRenderer.invoke(IPC.runStart, workflowId),
  cancelRun: (runId) => ipcRenderer.invoke(IPC.runCancel, runId),
  listRuns: () => ipcRenderer.invoke(IPC.runsList),
  getRun: (runId) => ipcRenderer.invoke(IPC.runGet, runId),
  deleteRun: (runId) => ipcRenderer.invoke(IPC.runDelete, runId),
  clearRunHistory: () => ipcRenderer.invoke(IPC.runsClear),
  getArtifact: (artifactId) => ipcRenderer.invoke(IPC.artifactGet, artifactId),
  onRunEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      // Events are trusted main-process payloads with a runId tag.
      listener(payload as RunEvent)
    }
    ipcRenderer.on(IPC.runEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.runEvent, wrapped)
    }
  },
  onNarration: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(payload as NarrationPayload)
    }
    ipcRenderer.on(IPC.voiceNarration, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.voiceNarration, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('flowloom', api)
