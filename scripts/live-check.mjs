#!/usr/bin/env node
/**
 * Live environment self-check — free by design.
 *
 * Performs real, read-only API calls with the credentials already
 * configured in .env (the app's own lookup order) and prints only
 * statuses. It creates NO browser session and generates NO audio, so
 * it spends no credits:
 *
 *   - Browserbase: GET /v1/sessions with the real API key.
 *   - ElevenLabs:  GET /v1/user/subscription, and the configured voice
 *                  ID via GET /v1/voices/{id} when ELEVENLABS_VOICE_ID
 *                  is set.
 *   - Paper Instruments: GET /v1/models and GET /v1/usage (documented
 *                  free endpoints; /v1/usage prints the real prepaid
 *                  balance when the API returns one). Never reaches
 *                  chat/completions, so no credit is spent.
 *
 * Secret values are never printed.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function loadEnv() {
  // Mirror the app's order: explicit override > home userData > cwd.
  const override = process.env['FLOWLOOM_ENV_PATH']
  const candidates = override
    ? [override]
    : [
        path.join(process.env['HOME'] ?? '', '.config', 'Flowloom', '.env'),
        path.join(root, '.env')
      ]
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue
    const values = {}
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return values
  }
  return {}
}

const env = { ...loadEnv(), ...process.env }
let failures = 0

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
  if (!ok) failures += 1
}

/* ---------------- Browserbase (read-only, free) ---------------- */
const bbKey = env['BROWSERBASE_API_KEY']
const bbProject = env['BROWSERBASE_PROJECT_ID']
if (!bbKey || !bbProject) {
  report('Browserbase credentials', false, 'missing or not configured')
} else {
  try {
    const res = await fetch('https://api.browserbase.com/v1/sessions', {
      headers: { 'x-bb-api-key': bbKey },
      signal: AbortSignal.timeout(15_000)
    })
    const ok = res.status === 200 && Array.isArray(await res.json())
    report(
      'Browserbase verification',
      ok,
      ok ? 'key accepted; project ID validated at run time by the API' : `HTTP ${res.status}`
    )
  } catch (error) {
    report('Browserbase verification', false, error instanceof Error ? error.message : 'network error')
  }
}

/* ---------------- ElevenLabs (read-only, free) ---------------- */
const elKey = env['ELEVENLABS_API_KEY']
const elVoice = env['ELEVENLABS_VOICE_ID']
if (!elKey) {
  report('ElevenLabs credentials', false, 'missing or not configured')
} else {
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': elKey },
      signal: AbortSignal.timeout(15_000)
    })
    report('ElevenLabs API key', res.status === 200, res.status === 200 ? 'accepted' : `HTTP ${res.status}`)
    if (res.status === 200 && elVoice) {
      const vRes = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(elVoice)}`, {
        headers: { 'xi-api-key': elKey },
        signal: AbortSignal.timeout(15_000)
      })
      report('ElevenLabs voice ID', vRes.status === 200, vRes.status === 200 ? 'exists in the account' : `HTTP ${vRes.status}`)
    } else if (!elVoice) {
      console.log('SKIP  ElevenLabs voice ID — ELEVENLABS_VOICE_ID not configured (voice test and narration need one)')
    }
  } catch (error) {
    report('ElevenLabs verification', false, error instanceof Error ? error.message : 'network error')
  }
}

/* ---------------- Paper Instruments (read-only, free) ---------------- */
const piKey = env['PAPERINSTRUMENTS_API_KEY']
const piModel = env['PAPERINSTRUMENTS_MODEL']
const PI_BASE = 'https://api.paperinstruments.com/v1'
if (!piKey) {
  report('Paper Instruments credentials', false, 'missing or not configured')
} else {
  try {
    const modelsRes = await fetch(`${PI_BASE}/models`, {
      headers: { Authorization: `Bearer ${piKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    report('Paper Instruments API key', modelsRes.status === 200, modelsRes.status === 200 ? 'accepted by GET /v1/models' : `HTTP ${modelsRes.status}`)
    if (modelsRes.status === 200 && piModel) {
      const modelRes = await fetch(`${PI_BASE}/models/${encodeURIComponent(piModel)}`, {
        headers: { Authorization: `Bearer ${piKey}` },
        signal: AbortSignal.timeout(15_000)
      })
      report(
        'Paper Instruments model ID',
        modelRes.status === 200,
        modelRes.status === 200 ? `${piModel} exists for this account` : `HTTP ${modelRes.status}`
      )
    } else if (!piModel) {
      console.log('SKIP  Paper Instruments model ID — PAPERINSTRUMENTS_MODEL not configured (generation needs one)')
    }
    if (modelsRes.status === 200) {
      const usageRes = await fetch(`${PI_BASE}/usage`, {
        headers: { Authorization: `Bearer ${piKey}` },
        signal: AbortSignal.timeout(15_000)
      })
      if (usageRes.status !== 200) {
        report('Paper Instruments balance', false, `GET /v1/usage returned HTTP ${usageRes.status}`)
      } else {
        const usage = await usageRes.json().catch(() => null)
        const available = usage && typeof usage.available_nanodollars === 'number' ? usage.available_nanodollars : null
        const reserved = usage && typeof usage.reserved_nanodollars === 'number' ? usage.reserved_nanodollars : null
        if (available === null) {
          console.log('SKIP  Paper Instruments balance — the usage response did not include a figure (nothing invented)')
        } else {
          const reservedText = reserved !== null ? ` (reserved: $${(reserved / 1e9).toFixed(2)})` : ''
          report('Paper Instruments balance', true, `prepaid balance available: $${(available / 1e9).toFixed(2)}${reservedText}`)
        }
      }
    }
  } catch (error) {
    report('Paper Instruments verification', false, error instanceof Error ? error.message : 'network error')
  }
}

console.log(failures === 0 ? '\nAll live checks passed (no credits spent).' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
