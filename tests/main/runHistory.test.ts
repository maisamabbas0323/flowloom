import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../../src/shared/runTypes'
import type { Logger } from '../../src/main/lib/log'
import { RunHistoryService, RUN_HISTORY_LIMIT } from '../../src/main/services/runHistory'

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function nodeRec(status: RunRecord['nodes'][number]['status'] = 'succeeded'): RunRecord['nodes'][number] {
  return {
    nodeId: 'n1',
    nodeType: 'data',
    title: 'Text value',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    error: null,
    outputSummary: 'hello'
  }
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    id: 'run_abc123xyz',
    workflowId: 'wf_test0001',
    workflowName: 'Test flow',
    schemaVersion: 1,
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 2000,
    nodes: [nodeRec()],
    error: null,
    cancelRequestedAt: null
  }
  if (overrides.id !== undefined) base.id = `run_${overrides.id}`
  return { ...base, ...overrides, id: base.id }
}

let dir: string
let history: RunHistoryService

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-hist-'))
  history = new RunHistoryService(dir, logger)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('run history', () => {
  it('round-trips a run record through disk', async () => {
    const original = record()
    await history.create(original)
    const loaded = await history.get(original.id)
    expect(loaded).toEqual(original)
    const summaries = await history.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: original.id,
      workflowId: original.workflowId,
      workflowName: 'Test flow',
      status: 'succeeded'
    })
  })

  it('updates incrementally: status transitions rewrite the same record', async () => {
    const running = record({ id: 'upd000xyz', status: 'running', finishedAt: null, durationMs: null })
    await history.save(running)
    const updated = { ...running, status: 'succeeded' as const, finishedAt: '2026-01-01T00:00:02.000Z', durationMs: 2000 }
    await history.save(updated)
    const loaded = await history.get('run_upd000xyz')
    expect(loaded?.status).toBe('succeeded')
    expect(await history.list()).toHaveLength(1)
  })

  it('lists runs newest first regardless of write order', async () => {
    await history.save(record({ id: 'later0000', startedAt: '2026-02-01T00:00:00.000Z' }))
    await history.save(record({ id: 'earlier00', startedAt: '2026-01-01T00:00:00.000Z' }))
    const summaries = await history.list()
    expect(summaries.map((run) => run.id)).toEqual(['run_later0000', 'run_earlier00'])
  })

  it('handles corrupted files as missing, keeps the store reliable', async () => {
    await history.save(record({ id: 'good00000' }))
    fs.writeFileSync(path.join(dir, 'run_corrupt1.json'), '}{garbage', 'utf8')
    expect(await history.get('run_corrupt1')).toBeNull()
    const good = await history.get('run_good00000')
    expect(good?.status).toBe('succeeded')
    // Listing also tolerates the damaged file without throwing.
    const summaries = await history.list()
    expect(summaries.map((run) => run.id)).toContain('run_good00000')
  })

  it('rejects malformed ids and keeps run files path-safe', async () => {
    expect(await history.get('../../etc/passwd')).toBeNull()
    expect(await history.get('not-a-run-id')).toBeNull()
  })

  it('retention keeps the newest records and never silently deletes recent ones', async () => {
    const total = RUN_HISTORY_LIMIT + 12
    for (let i = 0; i < total; i += 1) {
      const stamp = String(1000 + i).padStart(8, '0')
      // New entries go through create(), which owns retention.
      await history.create(record({ id: `rot${stamp}`, startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
    }
    const summaries = await history.list()
    expect(summaries).toHaveLength(RUN_HISTORY_LIMIT)
    // The oldest 12 were trimmed; the newest record always survives.
    expect(await history.get(`run_rot${String(1000).padStart(8, '0')}`)).toBeNull()
    const newest = await history.get(`run_rot${String(total - 1 + 1000).padStart(8, '0')}`)
    expect(newest).not.toBeNull()
  })

  it('keeps run history independent of workflow storage', async () => {
    // A run whose workflow was later deleted (or renamed) still opens.
    const original = record({ id: 'orphan000', workflowId: 'wf_deleted000', workflowName: 'Gone flow' })
    await history.create(original)
    // No workflow record exists anywhere on disk for wf_deleted000.
    const loaded = await history.get('run_orphan000')
    expect(loaded?.workflowName).toBe('Gone flow')
    expect(loaded?.nodes[0]).toBeTruthy()
  })
})

describe('run history deletion', () => {
  it('removes one run: file, index entry, and nothing else', async () => {
    await history.create(record({ id: 'delme0000' }))
    await history.create(record({ id: 'keepme000', startedAt: '2026-03-01T00:00:00.000Z' }))

    expect(await history.remove('run_delme0000')).toBe(true)
    expect(await history.get('run_delme0000')).toBeNull()
    const summaries = await history.list()
    expect(summaries.map((run) => run.id)).toEqual(['run_keepme000'])
    // The file is gone from disk, not just from the index.
    expect(fs.existsSync(path.join(dir, 'run_delme0000.json'))).toBe(false)
  })

  it('reports honestly when there is nothing to remove', async () => {
    await history.create(record({ id: 'stays0000' }))
    expect(await history.remove('run_unknown00')).toBe(false)
    expect(await history.remove('../escape00')).toBe(false)
    expect(await history.remove('not-a-run-id')).toBe(false)
    expect(await history.list()).toHaveLength(1)
  })

  it('clear() removes every record and the files, returning the real count', async () => {
    await history.create(record({ id: 'clr000001' }))
    await history.create(record({ id: 'clr000002', startedAt: '2026-02-01T00:00:00.000Z' }))
    await history.create(record({ id: 'clr000003', startedAt: '2026-03-01T00:00:00.000Z' }))

    expect(await history.clear()).toBe(3)
    expect(await history.list()).toEqual([])
    expect(await history.get('run_clr000001')).toBeNull()
    expect(fs.existsSync(path.join(dir, 'run_clr000001.json'))).toBe(false)
    // Clearing again is safe and honestly reports zero.
    expect(await history.clear()).toBe(0)
  })

  it('keeps the store usable after a clear (new runs save and list)', async () => {
    await history.create(record({ id: 'oldrun000' }))
    await history.clear()
    await history.create(record({ id: 'newrun000', startedAt: '2026-05-01T00:00:00.000Z' }))
    const summaries = await history.list()
    expect(summaries.map((run) => run.id)).toEqual(['run_newrun000'])
    expect((await history.get('run_newrun000'))?.status).toBe('succeeded')
  })

  it('serializes remove with concurrent saves (no interleaved index state)', async () => {
    await history.create(record({ id: 'race00001' }))
    const racing = Promise.all([
      history.save(record({ id: 'race00002', startedAt: '2026-02-01T00:00:00.000Z' })),
      history.remove('run_race00001'),
      history.save(record({ id: 'race00003', startedAt: '2026-03-01T00:00:00.000Z' }))
    ])
    await expect(racing).resolves.toBeTruthy()
    const ids = (await history.list()).map((run) => run.id)
    expect(ids).not.toContain('run_race00001')
    expect(ids).toContain('run_race00002')
    expect(ids).toContain('run_race00003')
  })
})
