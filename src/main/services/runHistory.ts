import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { RunRecord, RunSummary } from '../../shared/runTypes'
import { isRunRecordShape } from './execution/planner'
import type { Logger } from '../lib/log'

/**
 * Run-history persistence, built on the application-data architecture:
 * one JSON file per run inside <userData>/runs, plus a lightweight
 * index of summaries for the list view. Writes land atomically
 * (temp file + rename, like the other stores), so interrupted writes
 * can't corrupt neighbouring records; a damaged run file is reported
 * as missing rather than lying about its state.
 */

const RUNS_VERSION = 1

/** History retention policy (documented in agent.md). */
export const RUN_HISTORY_LIMIT = 200

interface RunIndex {
  version: number
  runs: RunSummary[]
}

export class RunHistoryService {
  private readonly dir: string
  private readonly logger: Logger | null
  /** Serializes index read-modify-write cycles (events arrive concurrently). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(runsDir: string, logger: Logger | null) {
    this.dir = runsDir
    this.logger = logger
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => undefined)
    return run
  }

  private get indexPath(): string {
    return path.join(this.dir, 'index.json')
  }

  private runPathFor(runId: string): string {
    return path.join(this.dir, `${runId}.json`)
  }
  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
  }

  private async readIndex(): Promise<RunIndex> {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(raw) as RunIndex
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.runs)) return parsed
    } catch {
      /* missing or damaged index — start over, run files decide truth */
    }
    return { version: RUNS_VERSION, runs: [] }
  }

  private async writeIndex(index: RunIndex): Promise<void> {
    await this.ensureDir()
    const temp = `${this.indexPath}.tmp`
    await fsp.writeFile(temp, JSON.stringify(index, null, 2), 'utf8')
    await fsp.rename(temp, this.indexPath)
  }

  private async writeRunFile(record: RunRecord): Promise<void> {
    await this.ensureDir()
    const file = this.runPathFor(record.id)
    const temp = `${file}.tmp`
    await fsp.writeFile(temp, JSON.stringify(record, null, 2), 'utf8')
    await fsp.rename(temp, file)
  }

  /** Create/overwrite the stored record for a run (used for updates too). */
  save(record: RunRecord): Promise<void> {
    return this.serialize(() => this.saveInner(record))
  }

  private async saveInner(record: RunRecord): Promise<void> {
    await this.writeRunFile(record)
    const index = await this.readIndex()
    const summary = toSummary(record)
    const existing = index.runs.findIndex((run) => run.id === record.id)
    if (existing >= 0) index.runs[existing] = summary
    else index.runs.unshift(summary)
    index.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    await this.writeIndex(index)
  }

  /**
   * Creates a run, then trims history beyond the retention limit.
   * Oldest records go first, and the most recent records are always
   * kept — nothing recent is ever silently dropped.
   */
  async create(record: RunRecord): Promise<void> {
    await this.save(record)
    try {
      await this.serialize(async () => {
        const index = await this.readIndex()
        const overLimit = index.runs.length - RUN_HISTORY_LIMIT
        if (overLimit > 0) {
          const removed = index.runs.splice(index.runs.length - overLimit, overLimit)
          await this.writeIndex({ version: RUNS_VERSION, runs: index.runs })
          for (const summary of removed) {
            await fsp.rm(this.runPathFor(summary.id), { force: true })
          }
        }
      })
    } catch (error) {
      this.logger?.warn(`Run-history trim failed: ${describe(error)}`)
    }
  }

  /**
   * Deletes one stored run (file + index entry). Serialized with the
   * write queue so a concurrent run update can't interleave and leave
   * a half-deleted state behind. Returns true when the run existed.
   */
  async remove(runId: string): Promise<boolean> {
    if (!isRunId(runId)) return false
    return this.serialize(async () => {
      const index = await this.readIndex()
      const before = index.runs.length
      index.runs = index.runs.filter((summary) => summary.id !== runId)
      const removedFromIndex = index.runs.length < before
      await fsp.rm(this.runPathFor(runId), { force: true })
      if (removedFromIndex) await this.writeIndex({ version: RUNS_VERSION, runs: index.runs })
      return removedFromIndex
    })
  }

  /**
   * Clears the whole run history: every stored run file and the index.
   * Returns the number of records that were removed (honest count from
   * the index, never estimated). A run that is still executing would
   * re-appear on its next transition — the UI refuses to clear while a
   * run is active for exactly this reason.
   */
  async clear(): Promise<number> {
    return this.serialize(async () => {
      const index = await this.readIndex()
      const count = index.runs.length
      await this.writeIndex({ version: RUNS_VERSION, runs: [] })
      const files = await fsp.readdir(this.dir).catch(() => [] as string[])
      await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => fsp.rm(path.join(this.dir, file), { force: true }))
      )
      return count
    })
  }

  /** Full record for the run-detail view, or null when unavailable. */
  async get(runId: string): Promise<RunRecord | null> {
    if (!isRunId(runId)) return null
    try {
      const raw = await fsp.readFile(this.runPathFor(runId), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return isRunRecordShape(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /** Summaries in newest-first order for the history list. */
  async list(): Promise<RunSummary[]> {
    let index: RunIndex
    try {
      index = await this.readIndex()
    } catch {
      return []
    }
    // Verify files referenced by the index still exist (self-heal after
    // interrupted trims or manual deletion).
    const summaries: RunSummary[] = []
    let changed = false
    for (const summary of index.runs) {
      try {
        await fsp.access(this.runPathFor(summary.id), fs.constants.F_OK)
        summaries.push(summary)
      } catch {
        changed = true
      }
    }
    if (changed) await this.writeIndex({ version: RUNS_VERSION, runs: summaries })
    return summaries
  }
}

function toSummary(record: RunRecord): RunSummary {
  return {
    id: record.id,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    error: record.error
  }
}

export function isRunId(runId: string): boolean {
  return /^run_[A-Za-z0-9_-]{6,64}$/.test(runId)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
