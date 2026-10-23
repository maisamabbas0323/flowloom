import { describe, expect, it, vi } from 'vitest'

import { NarrationService, type NarrationDeps } from '../../src/main/services/narration'
import type { RunEvent } from '../../src/shared/runTypes'

/**
 * Unit tests for the optional voice-narration layer. All generation is
 * driven through an injected mock fetch — no real ElevenLabs calls, no
 * credits consumed. The tests prove the honesty rules: narration only
 * fires for real events, respects its settings, deduplicates, drops
 * stale post-terminal events, and never affects or embeds run data.
 */

interface PushedPayload {
  eventKey: string
  text: string
  mimeType: string
  base64: string
  speed: number
}

function makeDeps(overrides?: Partial<NarrationDeps>): {
  deps: NarrationDeps
  pushed: PushedPayload[]
  settings: { enabled: boolean; successes: boolean; issues: boolean; browser: boolean; speed: number }
} {
  const settings = { enabled: true, successes: true, issues: true, browser: true, speed: 1 }
  const pushed: PushedPayload[] = []
  const deps: NarrationDeps = {
    settings: () => ({ ...settings }),
    credentials: () => ({ apiKey: 'x11-key', voiceId: 'voice-123' }),
    fetch: okFetch(),
    post: (payload) => {
      pushed.push(payload as PushedPayload)
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
  Object.assign(deps, overrides ?? {})
  return { deps, pushed, settings }
}

// The real fetch wrapper used by the provider layer needs these fields.
type Respond = {
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
  arrayBuffer: () => Promise<ArrayBuffer>
}

function okFetch(): typeof globalThis.fetch {
  // The provider insists on real audio-sized payloads; hand back a
  // binary buffer big enough to pass that honest size threshold.
  const bytes = new Uint8Array(64).fill(1)
  return (async () => {
    const response: Respond = {
      ok: true,
      status: 200,
      statusText: '200',
      text: async () => '',
      arrayBuffer: async () => bytes.buffer as ArrayBuffer
    }
    return response
  }) as unknown as typeof globalThis.fetch
}

function wf(status: string, runId = 'run_abc123', message?: string): RunEvent {
  return { type: 'workflow', runId, workflowId: 'wf_1', status: status as never, at: new Date().toISOString(), message }
}

function node(
  status: string,
  overrides?: { runId?: string; nodeId?: string; nodeType?: string; nodeTitle?: string }
): RunEvent {
  return {
    type: 'node',
    runId: overrides?.runId ?? 'run_abc123',
    workflowId: 'wf_1',
    nodeId: overrides?.nodeId ?? 'bx1',
    status: status as never,
    at: new Date().toISOString(),
    nodeType: (overrides?.nodeType ?? 'browserAction') as never,
    nodeTitle: overrides?.nodeTitle ?? 'Open example page'
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('NarrationService', () => {
  it('narrates a real workflow lifecycle in arrival order', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch() })
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    service.observe(node('succeeded'))
    service.observe(wf('succeeded'))
    await settle()
    expect(pushed.map((p) => p.text)).toEqual([
      'Workflow started.',
      'Browser step Open example page finished.',
      'The workflow completed successfully.'
    ])
    expect(pushed.every((p) => p.speed === 1)).toBe(true)
  })

  it('does not narrate anything while disabled or category off', async () => {
    const { deps, pushed, settings } = makeDeps({ fetch: okFetch() })
    settings.enabled = false
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    await settle()
    expect(pushed).toHaveLength(0)

    settings.enabled = true
    settings.successes = false
    // Re-enabled but the success category is off: still nothing spoken.
    service.observe(wf('succeeded'))
    await settle()
    expect(pushed).toHaveLength(0)
  })

  it('never narrates a failed run as success', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch() })
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    service.observe(wf('failed'))
    await settle()
    expect(pushed.map((p) => p.text)).toEqual(['Workflow started.', 'The workflow failed.'])
  })

  it('drops events after the run reached a terminal state', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch() })
    const service = new NarrationService(deps)
    service.observe(wf('cancelled'))
    // A slow browser node still resolving after cancellation.
    service.observe(node('succeeded', { runId: 'run_abc123' }))
    service.observe(wf('succeeded'))
    await settle()
    expect(pushed.map((p) => p.text)).toEqual(['The workflow was cancelled.'])
  })

  it('deduplicates repeated events for the same run and node', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch() })
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    service.observe(wf('queued'))
    service.observe(node('failed', { runId: 'run_abc123' }))
    service.observe(node('failed', { runId: 'run_abc123' }))
    service.observe(wf('failed'))
    service.observe(wf('failed'))
    await settle()
    expect(pushed.map((p) => p.text)).toEqual([
      'Workflow started.',
      'Browser step Open example page failed.',
      'The workflow failed.'
    ])
  })

  it('ignores non-browser node events entirely', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch() })
    const service = new NarrationService(deps)
    service.observe(node('succeeded', { nodeType: 'delay' }))
    service.observe(node('succeeded', { nodeType: 'condition' }))
    service.observe(node('running'))
    await settle()
    expect(pushed).toHaveLength(0)
  })

  it('skips generation without credentials and keeps working afterwards', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch(), credentials: () => null })
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    await settle()
    expect(pushed).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('narration failure never pushes payloads and never throws', async () => {
    const failing = (async () => {
      const response: Respond = {
        ok: false,
        status: 401,
        statusText: '401',
        text: async () => JSON.stringify({ detail: { status: 'detected_unusual_activity' } }),
        arrayBuffer: async () => new ArrayBuffer(0)
      }
      return response
    }) as unknown as typeof globalThis.fetch
    const { deps, pushed } = makeDeps({ fetch: failing })
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    service.observe(wf('succeeded'))
    await settle()
    expect(pushed).toHaveLength(0)
  })

  it('keeps secrets out of narration texts by construction', async () => {
    const { deps, pushed } = makeDeps({ fetch: okFetch() })
    const service = new NarrationService(deps)
    service.observe(node('succeeded', { nodeTitle: 'Visit https://example.com/private?key=secret' }))
    service.observe(wf('failed'))
    await settle()
    expect(pushed).toHaveLength(2)
    // The title is inherited through the event's nodeType; texts are
    // user-authored node titles, never provider secrets or page dumps.
    expect(pushed.every((p) => !p.text.includes('x11-key'))).toBe(true)
    expect(pushed.every((p) => !p.text.includes('voice-123'))).toBe(true)
  })

  it('shutdown drops the queue and stops accepting events', async () => {
    const { deps, pushed } = makeDeps()
    const service = new NarrationService(deps)
    service.observe(wf('queued'))
    service.shutdown()
    await settle()
    expect(pushed).toHaveLength(0)
    service.observe(wf('succeeded'))
    await settle()
    expect(pushed).toHaveLength(0)
  })
})
