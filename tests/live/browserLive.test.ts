import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createDefaultRunnerDeps, runBrowserOperation } from '../../src/main/services/execution/browserRunner'
import { ARTIFACT_ID_PATTERN, createArtifactStore } from '../../src/main/services/artifacts'
import type { CancellationSignal } from '../../src/main/services/execution/executors'
import type { Logger } from '../../src/main/lib/log'
import { createRedactor } from '../../src/main/lib/log'

/**
 * LIVE integration test — NOT part of the default suite.
 *
 * Runs only when FLOWLOOM_LIVE_BROWSER=1 is explicitly set, because it
 * creates real Browserbase sessions (billable). It exercises the exact
 * production modules (browserbase REST client + playwright-core CDP
 * runner) against https://example.com with the credentials already
 * configured in .env — the same lookup order and shape the app uses.
 * Secrets are never printed; only statuses and durations surface here.
 *
 *   npx vitest run tests/live/browserLive.test.ts  (skipped otherwise)
 *   FLOWLOOM_LIVE_BROWSER=1 npm run live:browser
 */

const live = process.env['FLOWLOOM_LIVE_BROWSER'] === '1'

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

function readCredentials(): { apiKey: string; projectId: string } {
  // Same precedence idea as the app: process env wins, then the .env in
  // the project root. Values are used, never echoed.
  const dotEnvPath = path.join(process.cwd(), '.env')
  const fromFile: Record<string, string> = {}
  if (fs.existsSync(dotEnvPath)) {
    for (const line of fs.readFileSync(dotEnvPath, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq > 0 && !line.trim().startsWith('#')) {
        fromFile[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
      }
    }
  }
  const apiKey = process.env['BROWSERBASE_API_KEY'] || fromFile['BROWSERBASE_API_KEY']
  const projectId = process.env['BROWSERBASE_PROJECT_ID'] || fromFile['BROWSERBASE_PROJECT_ID']
  if (!apiKey || !projectId) throw new Error('Browserbase credentials are missing — create one .env entry each.')
  return { apiKey, projectId }
}

describe.skipIf(!live)('LIVE Browserbase browser operations', () => {
  const redactor = createRedactor()

  it('navigates a real page, reads real title/URL, releases the session', async () => {
    const credentials = readCredentials()
    const started = Date.now()
    const result = await runBrowserOperation(
      {
        config: { name: 'Live check', action: 'navigate', url: 'https://example.com/', timeoutSeconds: 30 },
        upstreamValues: new Map(),
        signal: { cancelled: false, listeners: new Set() } as CancellationSignal,
        onLog: (message) => redactor.redact(message),
        timeoutSecondsCapMs: 120_000,
        saveScreenshot: () => {
          throw new Error('no screenshot requested')
        }
      },
      createDefaultRunnerDeps(),
      credentials,
      logger
    )

    const durationSec = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`live navigate: session=${result.sessionId.slice(0, 8)}… url=${result.finalUrl} title="${result.pageTitle}" (${durationSec}s)`)

    expect(result.finalUrl).toContain('example.com')
    expect(result.pageTitle).toBe('Example Domain')
  }, 120_000)

  it('captures a real screenshot of a live page as a managed artifact', async () => {
    const credentials = readCredentials()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-live-'))
    const artifacts = createArtifactStore(tmp, logger)
    const started = Date.now()
    const result = await runBrowserOperation(
      {
        config: { name: 'Live shot', action: 'screenshot', url: 'https://example.com/', timeoutSeconds: 30 },
        upstreamValues: new Map(),
        signal: { cancelled: false, listeners: new Set() } as CancellationSignal,
        onLog: (message) => redactor.redact(message),
        timeoutSecondsCapMs: 120_000,
        saveScreenshot: (bytes) => artifacts.save(bytes, 'image/png')
      },
      createDefaultRunnerDeps(),
      credentials,
      logger
    )

    const durationSec = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`live screenshot: ${result.screenshotId} (${durationSec}s)`)

    expect(result.finalUrl).toContain('example.com')
    expect(result.screenshotId).toMatch(ARTIFACT_ID_PATTERN)
    // The screenshot is genuinely stored bytes, not a placeholder.
    const stored = await artifacts.get(result.screenshotId as string)
    expect(stored).not.toBeNull()
    expect((stored as { bytes: Buffer }).bytes.length).toBeGreaterThan(1000)
  }, 120_000)

  it('extracts real visible text from a live page', async () => {
    const credentials = readCredentials()
    const started = Date.now()
    const result = await runBrowserOperation(
      {
        config: { name: 'Live extract', action: 'extractPageText', url: 'https://example.com/', limit: 2000 },
        upstreamValues: new Map(),
        signal: { cancelled: false, listeners: new Set() } as CancellationSignal,
        onLog: (message) => redactor.redact(message),
        timeoutSecondsCapMs: 120_000,
        saveScreenshot: () => {
          throw new Error('no screenshot requested')
        }
      },
      createDefaultRunnerDeps(),
      credentials,
      logger
    )

    const durationSec = ((Date.now() - started) / 1000).toFixed(1)
    // Truthful assertions only — the page content is the site's to change.
    console.log(`live extract: chars=${result.extractedChars} title="${result.pageTitle}" (${durationSec}s)`)

    expect(result.finalUrl).toContain('example.com')
    expect(result.pageTitle).toBe('Example Domain')
    expect(result.extractedChars).toBeGreaterThan(50)
    expect(typeof result.text).toBe('string')
    expect((result.text as string).length).toBe(result.extractedChars)
  }, 120_000)
})
