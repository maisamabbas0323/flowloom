import { app, BrowserWindow, shell } from 'electron'
import * as path from 'node:path'
import { createRedactor } from './lib/log'
import { createLogger } from './lib/log'
import { createEnvSource } from './env/envSource'
import { ConfigService } from './config/service'
import { createElectronSecureStorage } from './config/electronSecureStorage'
import { SecretsVault } from './config/vault'
import { defaultSettings, type PersistedSettings } from './config/settingsSchema'
import { JsonStore } from './lib/jsonStore'
import { registerIpc } from './ipc/register'
import { ConnectionTester } from './services/connectionTests'
import { WorkflowService } from './services/workflows'
import type { RunEvent } from '../shared/runTypes'
import { ExecutionEngine } from './services/execution/engine'
import { RunHistoryService } from './services/runHistory'
import { setBrowserExecutor, setPaperExecutor } from './services/execution/executors'
import { makeBrowserExecutor } from './services/execution/browserExecutor'
import { makePaperExecutor } from './services/execution/paperExecutor'
import { createDefaultRunnerDeps } from './services/execution/browserRunner'
import { createArtifactStore } from './services/artifacts'
import { NarrationService } from './services/narration'
import { IPC } from '../shared/contracts'

/**
 * Flowloom main process.
 *
 * Responsibilities: window lifecycle, the single configuration service,
 * secrets, real provider connection tests, and workflow records. Provider
 * credentials and privileged operations never touch the renderer.
 */

/**
 * Dev tools conditional.
 */
const isDev = !!process.env['ELECTRON_RENDERER_URL']

/**
 * Unpackaged runs (dev, preview, or a direct `electron out/` launch)
 * honor a project-root `.env` alongside the userData location; packaged
 * installs do not, since their cwd is not a project directory.
 */
const loadsProjectEnv = app.isPackaged === false

let mainWindow: BrowserWindow | null = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    bootstrap()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void app.whenReady().then(() => createMainWindow())
    }
  })
}

function bootstrap(): void {
  // One redactor feeds both the local developer log and test results so
  // any known secret value is scrubbed before leaving the main process.
  const redactor = createRedactor()
  const logger = createLogger(redactor)

  const userDataDir = app.getPath('userData')
  const appVersion = app.getVersion()
  const envSource = createEnvSource(process, userDataDir, loadsProjectEnv)
  logger.info(
    `Starting Flowloom ${appVersion} (${process.platform}) — ${
      envSource.getPath() ? `.env loaded from ${envSource.getPath()}` : 'no .env file found'
    }`
  )

  const settingsStore = new JsonStore<PersistedSettings>(
    path.join(userDataDir, 'settings.json'),
    defaultSettings,
    logger
  )
  const vault = new SecretsVault(
    path.join(userDataDir, 'secrets.json'),
    createElectronSecureStorage(),
    logger
  )

  const config = new ConfigService({
    settings: settingsStore,
    env: envSource,
    vault,
    logger,
    secureStorage: createElectronSecureStorage(),
    appVersion,
    platform: process.platform,
    redactor
  })

  const tester = new ConnectionTester({
    config,
    logger,
    fetchImpl: globalThis.fetch.bind(globalThis)
  })
  const workflows = new WorkflowService(path.join(userDataDir, 'workflows'), logger)

  // Execution: engine owns run lifecycles and publishes typed events to
  // every open window; the renderer receives no secrets — only run and
  // node statuses plus already-redacted summaries.
  const runHistory = new RunHistoryService(path.join(userDataDir, 'runs'), logger)
  const artifactStore = createArtifactStore(userDataDir, logger)
  const postPayload = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channel, payload)
    }
  }
  const publishRunEvent = (event: RunEvent): void => {
    postPayload(IPC.runEvent, event)
  }
  // Optional voice narration observes the same real event stream —
  // generation happens only when enabled in Settings, and narration
  // failures never touch run execution or history.
  const narration = new NarrationService({
    settings: () => config.getNarrationSettings(),
    credentials: () => {
      const apiKey = config.getPlainSecret('elevenlabsApiKey')
      const voiceId = config.getEffectiveVoiceId()
      if (!apiKey || !voiceId) return null
      return { apiKey, voiceId }
    },
    fetch: globalThis.fetch.bind(globalThis),
    post: (payload) => postPayload(IPC.voiceNarration, payload),
    logger
  })
  const publishAll = (event: RunEvent): void => {
    publishRunEvent(event)
    narration.observe(event)
  }
  setBrowserExecutor(
    makeBrowserExecutor({
      runner: createDefaultRunnerDeps(),
      artifactStore,
      logger,
      // Resolved at execution time from the one config service — never
      // baked into workflows or outputs.
      credentials: async () => {
        const apiKey = config.getPlainSecret('browserbaseApiKey')
        const projectId = config.getEffectiveBrowserProjectId()
        if (!apiKey || !projectId) return null
        return { apiKey, projectId }
      }
    })
  )
  setPaperExecutor(
    makePaperExecutor({
      fetch: globalThis.fetch.bind(globalThis),
      logger,
      credentials: () => {
        const apiKey = config.getPlainSecret('paperinstrumentsApiKey')
        if (!apiKey) return null
        return { apiKey }
      },
      effectiveModel: () => config.getEffectivePaperModel(),
      enabled: () => config.getPaperEnabled(),
      minBalanceUsd: () => config.getPaperMinBalanceUsd()
    })
  )
  const engine = new ExecutionEngine({
    workflows,
    history: runHistory,
    redactor,
    logger,
    publish: publishAll,
    credentialGate: (nodes) => {
      if (nodes.some((node) => node.type === 'browserAction')) {
        const apiKey = config.getPlainSecret('browserbaseApiKey')
        const projectId = config.getEffectiveBrowserProjectId()
        if (!apiKey && !projectId) {
          return 'Browserbase is not configured — add the API key and project ID in Settings (or via the environment) before running a browser step.'
        }
        if (!apiKey) {
          return 'The Browserbase API key is missing — add it in Settings (or set BROWSERBASE_API_KEY) before running a browser step.'
        }
        if (!projectId) {
          return 'The Browserbase project ID is missing — add it in Settings (or set BROWSERBASE_PROJECT_ID) before running a browser step.'
        }
      }
      if (nodes.some((node) => node.type === 'paperInstruments')) {
        if (!config.getPaperEnabled()) {
          return 'Paper Instruments is switched off in Settings — turn it on (it makes billable model calls) or remove the Paper Instruments step.'
        }
        if (!config.getPlainSecret('paperinstrumentsApiKey')) {
          return 'The Paper Instruments API key is missing — add it in Settings (or set PAPERINSTRUMENTS_API_KEY) before running a Paper Instruments step.'
        }
        const settingsModel = config.getEffectivePaperModel()
        const everyNodeHasModel = nodes
          .filter((node) => node.type === 'paperInstruments')
          .every((node) => typeof node.config['model'] === 'string' && node.config['model'].trim() !== '')
        if (settingsModel === '' && !everyNodeHasModel) {
          return 'No Paper Instruments model ID is configured — set the exact model ID in Settings (or PAPERINSTRUMENTS_MODEL), or on each Paper Instruments step. Flowloom never guesses a model name.'
        }
      }
      return null
    }
  })
  app.on('before-quit', () => {
    narration.shutdown()
    engine.shutdown()
  })

  registerIpc({ config, tester, workflows, engine, runs: runHistory, artifacts: artifactStore, logger })

  createMainWindow()
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#FAFAFA',
    title: 'Flowloom',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev
    }
  })

  // Only ever load our own bundle. External navigations and windows are
  // refused; https links may open in the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  if (isDev) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  mainWindow = window
}
