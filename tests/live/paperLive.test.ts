import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { testPaperInstruments, generatePaperCompletion, PAPER_INSTRUMENTS_BASE_URL } from '../../src/main/providers/paperinstruments'

/**
 * LIVE integration test — NOT part of the default suite.
 *
 *   FLOWLOOM_LIVE_PAPER=1 npm run live:paper
 *
 * Two stages with different cost profiles:
 * 1. Free verification (enabled by FLOWLOOM_LIVE_PAPER=1 alone): the
 *    three documented unbilled GETs — /v1/models, the configured model
 *    lookup via GET /v1/models/{id}, and GET /v1/usage, whose REAL
 *    prepaid balance is printed verbatim.
 * 2. One bounded billable generation (max 128 completion tokens, low
 *    reasoning effort) — additional gate FLOWLOOM_LIVE_PAPER_GENERATION=1
 *    so a wrong flag typing can never silently spend credit.
 *
 * Secrets are never printed; results are never fabricated: a failed or
 * unparsable response fails the test rather than inventing success.
 */

const live = process.env['FLOWLOOM_LIVE_PAPER'] === '1'
const generationLive = live && process.env['FLOWLOOM_LIVE_PAPER_GENERATION'] === '1'

function readCredentials(): { apiKey: string; modelId: string } {
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
  const apiKey = process.env['PAPERINSTRUMENTS_API_KEY'] || fromFile['PAPERINSTRUMENTS_API_KEY']
  const modelId = process.env['PAPERINSTRUMENTS_MODEL'] || fromFile['PAPERINSTRUMENTS_MODEL']
  if (!apiKey) throw new Error('PAPERINSTRUMENTS_API_KEY is missing — nothing to verify.')
  if (!modelId) throw new Error('PAPERINSTRUMENTS_MODEL is missing — Flowloom never picks a model on its own.')
  return { apiKey, modelId }
}

describe.skipIf(!live)('LIVE Paper Instruments free verification', () => {
  it('verifies the key, the configured model, and reports the real prepaid balance', async () => {
    const { apiKey, modelId } = readCredentials()
    const started = Date.now()
    const outcome = await testPaperInstruments(
      { fetch: globalThis.fetch, timeoutMs: 30_000 },
      { apiKey, modelId }
    )
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (!outcome.ok) {
      throw new Error(`Free verification failed: ${outcome.code} — ${outcome.message}`)
    }
    console.log(`live paper: verified in ${seconds}s — ${outcome.message}`)
    // A key that cannot reach /v1/models is an auth failure, honestly
    // reported above; success must name the mode and point at the API.
    expect(outcome.message).toMatch(/Connected/)
  }, 60_000)
})

describe.skipIf(!generationLive)('LIVE Paper Instruments bounded generation (billable)', () => {
  it('generates a short bounded reply and reports only real usage figures', async () => {
    const { apiKey, modelId } = readCredentials()
    const started = Date.now()
    const outcome = await generatePaperCompletion(
      { fetch: globalThis.fetch, timeoutMs: 60_000 },
      { apiKey },
      {
        model: modelId,
        prompt: 'Reply with exactly the word: acknowledged',
        maxCompletionTokens: 128,
        reasoningEffort: 'low'
      }
    )
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (!outcome.ok) {
      throw new Error(`Generation failed: ${outcome.code} — ${outcome.message}`)
    }
    console.log(
      `live paper generation: finish_reason=${outcome.finishReason ?? 'unknown'} tokens=` +
        `${outcome.usage?.promptTokens ?? '?'}/${outcome.usage?.completionTokens ?? '?'} ` +
        `(reasoning ${outcome.usage?.reasoningTokens ?? '?'}, total ${outcome.usage?.totalTokens ?? '?'}) in ${seconds}s`
    )
    console.log(`live paper generation endpoint: ${PAPER_INSTRUMENTS_BASE_URL}/chat/completions`)
    expect(typeof outcome.content).toBe('string')
  }, 120_000)
})
