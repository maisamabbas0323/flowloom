import { ipcMain } from 'electron'

import {
  IPC,
  isClearOverrideKey,
  type AppConfigView,
  type VoiceTestResult,
  type WorkflowGraph,
  type ClearOverrideKey,
  type RunRecord,
  type RunSummary
} from '../../shared/contracts'
import type { ConfigService } from '../config/service'
import type { ConnectionTester } from '../services/connectionTests'
import type { WorkflowService } from '../services/workflows'
import { sanitizeView } from '../services/workflows'
import type { ExecutionEngine } from '../services/execution/engine'
import type { RunHistoryService } from '../services/runHistory'
import { isRunId } from '../services/runHistory'
import { isArtifactId, type ArtifactStore } from '../services/artifacts'
import type { Logger } from '../lib/log'

/**
 * The entire IPC surface. Small, explicit, and validated.
 *
 * The renderer can only call these fixed handlers — no arbitrary channel
 * invocation exists, and no handler returns credential material.
 */

interface Services {
  config: ConfigService
  tester: ConnectionTester
  workflows: WorkflowService
  engine: ExecutionEngine
  runs: RunHistoryService
  artifacts: ArtifactStore
  logger: Logger
}

export function registerIpc(services: Services): void {
  /* configuration --------------------------------------------------- */

  ipcMain.handle(IPC.configGet, (): AppConfigView => services.config.describe())

  ipcMain.handle(IPC.configSave, (_event, section: unknown, input: unknown) => {
    try {
      if (section === 'model') return services.config.saveModel(asRecord(input))
      if (section === 'voice') return services.config.saveVoice(asRecord(input))
      if (section === 'browser') return services.config.saveBrowser(asRecord(input))
      if (section === 'paper') return services.config.savePaper(asRecord(input))
      if (section === 'general') return services.config.saveGeneral(asRecord(input))
      return { ok: false, errors: { section: 'Unknown settings section.' }, config: services.config.describe() }
    } catch (error) {
      services.logger.error('Settings save failed.', error)
      return { ok: false, errors: { section: 'Saving failed unexpectedly.' }, config: services.config.describe() }
    }
  })

  ipcMain.handle(IPC.configClearOverride, (_event, key: unknown) => {
    if (typeof key !== 'string' || !isClearOverrideKey(key)) {
      return { ok: false, errors: { key: 'Unknown setting.' }, config: services.config.describe() }
    }
    try {
      return services.config.clearOverride(key as ClearOverrideKey)
    } catch (error) {
      services.logger.error('Clearing override failed.', error)
      return { ok: false, errors: { key: 'Clearing the override failed unexpectedly.' }, config: services.config.describe() }
    }
  })

  ipcMain.handle(IPC.configTest, async (_event, section: unknown) => {
    if (section === 'model') return services.tester.runModelTest()
    if (section === 'voice') return services.tester.runVoiceTest()
    if (section === 'browser') return services.tester.runBrowserTest()
    if (section === 'paper') return services.tester.runPaperTest()
    return { status: 'failed', code: 'unknown', message: 'Unknown test.', at: new Date().toISOString() }
  })

  // Paper Instruments "Test generation": a real, minimal, user-initiated
  // generation — never triggered by startup, and never by the scheduler.
  ipcMain.handle(IPC.configTestPaperGeneration, () => services.tester.runPaperGenerationTest())

  ipcMain.handle(IPC.configTestVoice, async (): Promise<VoiceTestResult> => {
    return services.tester.runVoiceTest()
  })

  /* system ----------------------------------------------------------- */

  ipcMain.handle(IPC.systemInfo, () => {
    const config = services.config.describe()
    return {
      platform: config.capabilities.platform,
      appVersion: config.capabilities.appVersion,
      secureStorageAvailable: config.capabilities.secureStorageAvailable,
      envFilePath: config.capabilities.envFilePath
    }
  })

  /* workflow records -------------------------------------------------- */

  ipcMain.handle(IPC.workflowList, () => safe(() => services.workflows.list(), services.logger, []))

  ipcMain.handle(IPC.workflowCreate, (_event, input: unknown) =>
    safe(
      () => {
        const name = readString(input, 'name' as const, '')
        return services.workflows.create({ name })
      },
      services.logger,
      null
    )
  )

  ipcMain.handle(IPC.workflowGet, (_event, id: unknown) =>
    safe(() => {
      if (typeof id !== 'string') throw new Error('Workflow id must be a string.')
      return services.workflows.get(id)
    }, services.logger, null)
  )

  ipcMain.handle(IPC.workflowDelete, (_event, id: unknown) =>
    safe(() => {
      if (typeof id !== 'string') throw new Error('Workflow id must be a string.')
      return services.workflows.delete(id)
    }, services.logger, false)
  )

  ipcMain.handle(IPC.workflowSave, (_event, input: unknown) =>
    safe(
      () => {
        if (typeof input !== 'object' || input === null) throw new Error('Malformed workflow payload.')
        const record = input as Record<string, unknown>
        if (typeof record['id'] !== 'string') throw new Error('Workflow id must be a string.')
        if (typeof record['name'] !== 'string') throw new Error('Workflow name must be a string.')
        const graph = record['graph'] as WorkflowGraph | undefined
        if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
          throw new Error('Workflow graph must include nodes and edges arrays.')
        }
        return services.workflows.save({
          id: record['id'],
          name: record['name'],
          description: typeof record['description'] === 'string' ? record['description'] : undefined,
          graph,
          // Omit the key when absent so the service keeps the stored view
          // rather than resetting it; sanitizeView rejects broken payloads.
          view: ('view' in record) ? sanitizeView(record['view']) : undefined
        })
      },
      services.logger,
      { ok: false, errors: ['Saving failed for an internal reason. Check the developer log.'] } as never
    )
  )

  ipcMain.handle(IPC.workflowDuplicate, (_event, id: unknown) =>
    safe(() => {
      if (typeof id !== 'string') throw new Error('Workflow id must be a string.')
      return services.workflows.duplicate(id)
    }, services.logger, null)
  )

  /* workflow execution ------------------------------------------------ */

  ipcMain.handle(IPC.runStart, (_event, workflowId: unknown) =>
    safe(() => {
      if (typeof workflowId !== 'string') {
        return { ok: false, errors: ['A workflow id is required to start a run.'] } as const
      }
      return services.engine.start(workflowId)
    }, services.logger, { ok: false, errors: ['Starting the run failed for an internal reason.'] } as never)
  )

  ipcMain.handle(IPC.runCancel, (_event, runId: unknown) =>
    safe(() => {
      if (typeof runId !== 'string') return false
      return services.engine.cancel(runId)
    }, services.logger, false)
  )

  ipcMain.handle(IPC.runsList, async (): Promise<RunSummary[]> => {
    try {
      return await services.runs.list()
    } catch (error) {
      services.logger.error('Listing runs failed.', error)
      return []
    }
  })

  ipcMain.handle(IPC.runGet, async (_event, runId: unknown): Promise<RunRecord | null> => {
    try {
      if (typeof runId !== 'string' || !isRunId(runId)) return null
      return await services.runs.get(runId)
    } catch (error) {
      services.logger.error('Loading a run failed.', error)
      return null
    }
  })

  ipcMain.handle(IPC.runDelete, async (_event, runId: unknown): Promise<boolean> => {
    try {
      if (typeof runId !== 'string' || !isRunId(runId)) return false
      return await services.runs.remove(runId)
    } catch (error) {
      services.logger.error('Deleting a run failed.', error)
      return false
    }
  })

  ipcMain.handle(IPC.runsClear, async (): Promise<number> => {
    try {
      return await services.runs.clear()
    } catch (error) {
      services.logger.error('Clearing run history failed.', error)
      return 0
    }
  })

  /* browser artifacts ------------------------------------------------- */

  ipcMain.handle(IPC.artifactGet, async (_event, artifactId: unknown): Promise<ArtifactPayload | null> => {
    if (!isArtifactId(artifactId)) return null
    try {
      const artifact = await services.artifacts.get(artifactId)
      if (!artifact) return null
      return {
        id: artifactId,
        mimeType: artifact.mimeType,
        base64: artifact.bytes.toString('base64')
      }
    } catch (error) {
      services.logger.error('Loading an artifact failed.', error)
      return null
    }
  })
}

/* ------------------------------------------------------------------ */

function asRecord(input: unknown): Record<string, unknown> {
  // Settings payloads travel as plain JSON objects; anything else is
  // rejected instead of processed.
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Malformed settings payload.')
  }
  const record = input as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (!isAllowedSettingValue(value)) {
      throw new Error(`Invalid value for setting field "${key}" (must be a string, null, boolean, or undefined).`)
    }
  }
  return record
}

function isAllowedSettingValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'undefined'
}

function safe<T>(fn: () => T, logger: Logger, fallback: T): T {
  try {
    return fn()
  } catch (error) {
    logger.error('IPC handler error.', error)
    return fallback
  }
}

/** One validated artifact read result. Only generated ids are served. */
export interface ArtifactPayload {
  id: string
  mimeType: string
  base64: string
}

function readString<T extends string>(input: unknown, key: T, fallback: string): string {
  if (typeof input === 'object' && input !== null) {
    const value = (input as Record<string, unknown>)[key as string]
    if (typeof value === 'string') return value
  }
  return fallback
}
