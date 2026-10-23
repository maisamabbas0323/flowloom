import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { generateSpeech } from '../../src/main/providers/elevenlabs'

/**
 * LIVE integration test — NOT part of the default suite.
 *
 * Runs only when FLOWLOOM_LIVE_VOICE=1 is explicitly set, because it
 * generates a short piece of real ElevenLabs audio (a "Test voice"
 * equivalent, minutes' worth of free-tier credit at most). It verifies
 * the exact production generation path used by the voice test and by
 * the optional narration: real key, real configured voice ID, real
 * mp3 bytes. Secrets are never printed.
 *
 *   FLOWLOOM_LIVE_VOICE=1 npm run live:voice
 */

const live = process.env['FLOWLOOM_LIVE_VOICE'] === '1'

function readCredentials(): { apiKey: string; voiceId: string } {
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
  const apiKey = process.env['ELEVENLABS_API_KEY'] || fromFile['ELEVENLABS_API_KEY']
  const voiceId = process.env['ELEVENLABS_VOICE_ID'] || fromFile['ELEVENLABS_VOICE_ID']
  if (!apiKey || !voiceId) throw new Error('ElevenLabs credentials are missing (need the API key and a voice ID).')
  return { apiKey, voiceId }
}

describe.skipIf(!live)('LIVE ElevenLabs speech generation', () => {
  it('generates real audio bytes for a short safe text', async () => {
    const credentials = readCredentials()
    const started = Date.now()
    const outcome = await generateSpeech(
      { fetch: globalThis.fetch, timeoutMs: 30_000 },
      credentials,
      'Flowloom live voice check.'
    )
    const durationSec = ((Date.now() - started) / 1000).toFixed(1)

    if (outcome.connection) {
      // Report honestly and fail the live test — never fake success.
      throw new Error(`Generation refused: ${outcome.connection.code} — ${outcome.connection.message}`)
    }

    const audio = outcome.audio
    expect(audio).toBeDefined()
    expect((audio as { mimeType: string }).mimeType).toBe('audio/mpeg')
    const bytes = Buffer.from((audio as { base64: string }).base64, 'base64')
    console.log(`live voice: ${bytes.length} bytes of mp3 in ${durationSec}s — real audio generated.`)
    // A real spoken sentence is kilobytes, not the empty/thin payload a
    // broken handler would return.
    expect(bytes.length).toBeGreaterThan(2000)
  }, 60_000)
})
