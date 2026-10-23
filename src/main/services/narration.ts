import { generateSpeech } from '../providers/elevenlabs'
import type { NarrationPayload, RunEvent } from '../../shared/runTypes'
import type { Logger } from '../lib/log'
/**
 * Optional voice narration built on the real ElevenLabs provider.
 *
 * Design rules (all verified behavior, no simulations):
 * - The execution engine stays the source of truth; narration consumes
 *   the same typed RunEvent stream the renderer sees — nothing else.
 * - Only meaningful events are spoken: a run started, succeeded,
 *   failed, or cancelled, and—optionally—the completion of a browser
 *   step (the long, networked operation users wait on).
 * - Messages come from fixed, safe templates: statuses and node titles
 *   (user-authored text, capped at 80 chars) only. Extracted page
 *   content, error internals, and secrets are never spoken.
 * - Generation is serialized through a queue so announcements never
 *   overlap, deduped per event, and dropped the moment narration is
 *   switched off or the app closes.
 * - Generation happens only when voice feedback is enabled and the run
 *   category is on, and only on demand — no credits are spent at
 *   startup or during the test suite. Failures are logged once and
 *   never affect workflow execution or history.
 */

export interface NarrationSettings {
  enabled: boolean
  successes: boolean
  issues: boolean
  browser: boolean
  speed: number
}

export interface NarrationCredentials {
  apiKey: string
  voiceId: string
}

export interface NarrationDeps {
  settings(): NarrationSettings
  credentials(): NarrationCredentials | null
  fetch: typeof globalThis.fetch
  /** Fan-out to open renderer windows (plays the audio locally). */
  post(payload: NarrationPayload): void
  logger: Logger
  now?: () => number
}

const MAX_TEXT_LEN = 240
const SPEECH_TIMEOUT_MS = 30_000
const FAILURE_LOG_INTERVAL_MS = 30_000

interface Announcement {
  eventKey: string
  category: 'successes' | 'issues'
  text: string
}

interface RunNarrationState {
  announced: Set<string>
  /** Set once the run reaches a terminal state; late events are ignored. */
  terminal: boolean
}

export class NarrationService {
  private readonly deps: NarrationDeps
  private readonly runs = new Map<string, RunNarrationState>()
  private queue: Announcement[] = []
  private pumping = false
  private stopped = false
  private lastFailureLog = new Map<string, number>()

  constructor(deps: NarrationDeps) {
    this.deps = deps
  }

  observe(event: RunEvent): void {
    if (this.stopped) return
    if (event.type === 'workflow') {
      const state = this.upsertRun(event.runId)
      switch (event.status) {
        case 'queued':
          this.enqueue(
            {
              eventKey: `${event.runId}:queued`,
              category: 'successes',
              text: 'Workflow started.'
            },
            state
          )
          return
        case 'succeeded':
          this.finishRun(event.runId, 'successes', 'The workflow completed successfully.')
          return
        case 'failed':
          this.finishRun(event.runId, 'issues', 'The workflow failed.')
          return
        case 'cancelled':
          this.finishRun(event.runId, 'issues', 'The workflow was cancelled.')
          return
        default:
          return // validating / running / cancelling are never narrated
      }
    }

    // Node events: only a *finished* browser step is announcement-worthy.
    if (event.type !== 'node') return
    if (event.nodeType !== 'browserAction') return
    const state = this.runs.get(event.runId) ?? this.upsertRun(event.runId)
    if (state.terminal) return // no speech after the run already ended
    if (event.status === 'succeeded' || event.status === 'failed') {
      const title = sanitizeTitle(event.nodeTitle)
      const text =
        event.status === 'succeeded'
          ? `Browser step ${title} finished.`
          : `Browser step ${title} failed.`
      this.enqueue(
        {
          eventKey: `${event.runId}:${event.nodeId}:${event.status}`,
          category: event.status === 'succeeded' ? 'successes' : 'issues',
          text
        },
        state
      )
    }
  }

  /** Drops everything queued and stops accepting events (app quit). */
  shutdown(): void {
    this.stopped = true
    this.queue = []
  }

  runsTracked(): number {
    return this.runs.size
  }

  queueLength(): number {
    return this.queue.length
  }

  /* ---------------------------------------------------------------- */

  private upsertRun(runId: string): RunNarrationState {
    let state = this.runs.get(runId)
    if (!state) {
      state = { announced: new Set(), terminal: false }
      this.runs.set(runId, state)
      // Keep the map bounded under churn.
      while (this.runs.size > 64) {
        const oldest = this.runs.keys().next()
        if (oldest.done) break
        this.runs.delete(oldest.value)
      }
    }
    return state
  }

  private finishRun(runId: string, category: 'successes' | 'issues', text: string): void {
    const state = this.upsertRun(runId)
    state.terminal = true
    // The enqueued key doubles as the terminal dedupe marker, so a
    // second terminal event for the same run is a no-op.
    this.enqueue({ eventKey: `${runId}:terminal`, category, text }, state)
  }

  private enqueue(
    announcement: Announcement,
    state: RunNarrationState
  ): void {
    if (this.stopped) return
    if (state.announced.has(announcement.eventKey)) return
    state.announced.add(announcement.eventKey)
    this.queue.push(announcement)
    void this.pump()
  }

  /** Serialized dispatch: one generation at a time, in arrival order. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        if (this.stopped) {
          this.queue = []
          return
        }
        const next = this.queue.shift()!
        const settings = this.deps.settings()
        const categoryOn =
          next.category === 'successes'
            ? settings.successes
            : settings.issues
        if (!settings.enabled || !categoryOn) continue

        const credentials = this.deps.credentials()
        if (!credentials) {
          this.logThrottled(
            'unconfigured',
            'Narration is enabled but ElevenLabs is not configured — speech was skipped.',
            'warn'
          )
          continue
        }

        const payload = await this.generate(credentials, next.text)
        if (payload && !this.stopped) this.deps.post({ ...payload, eventKey: next.eventKey })
      }
    } finally {
      this.pumping = false
    }
  }

  private async generate(
    credentials: NarrationCredentials,
    text: string
  ): Promise<Omit<NarrationPayload, 'eventKey'> | null> {
    const bounded = text.slice(0, MAX_TEXT_LEN)
    try {
      const outcome = await generateSpeech(
        { fetch: this.deps.fetch, timeoutMs: SPEECH_TIMEOUT_MS },
        credentials,
        bounded
      )
      if (outcome.connection) {
        this.logThrottled(outcome.connection.code, `Narration skipped: ${outcome.connection.message}`)
        return null
      }
      if (!outcome.audio) {
        this.logThrottled('no_audio', 'Narration skipped: the provider returned no audio.')
        return null
      }
      return {
        text: bounded,
        mimeType: outcome.audio.mimeType,
        base64: outcome.audio.base64,
        speed: this.deps.settings().speed
      }
    } catch (error) {
      this.logThrottled(
        'exception',
        `Narration skipped: ${error instanceof Error ? error.message : 'unexpected error'}`
      )
      return null
    }
  }

  private logThrottled(key: string, message: string, level: 'warn' | 'info' = 'warn'): void {
    const now = this.deps.now?.() ?? Date.now()
    const last = this.lastFailureLog.get(key) ?? 0
    if (now - last < FAILURE_LOG_INTERVAL_MS) return
    this.lastFailureLog.set(key, now)
    if (level === 'warn') this.deps.logger.warn(message)
    else this.deps.logger.info(message)
  }
}

/** Node titles are user-authored text; strip control chars and cap. */
function sanitizeTitle(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
  return (cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned) || 'the step'
}
