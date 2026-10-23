import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Logger } from '../lib/log'

/**
 * Application-managed storage for browser artifacts (screenshots).
 *
 * - Files live under `<userData>/artifacts/` with generated ids — never
 *   a renderer-supplied path.
 * - Screenshots are NOT embedded in workflow definitions or run-history
 *   JSON; history references the artifact id only.
 * - `getArtifact` is the narrow read surface used by one validated IPC
 *   handler; it admits only well-formed ids and bounded file sizes.
 */

export const ARTIFACT_ID_PATTERN = /^art_[a-z0-9]{24}$/
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

export interface ArtifactStore {
  save(bytes: Buffer, mimeType: string): Promise<string>
  get(id: string): Promise<{ bytes: Buffer; mimeType: string } | null>
  exists(id: string): Promise<boolean>
}

export function createArtifactStore(baseDir: string, logger: Logger): ArtifactStore {
  const dir = path.join(baseDir, 'artifacts')

  async function ensureDir(): Promise<void> {
    await fsp.mkdir(dir, { recursive: true })
  }

  return {
    async save(bytes, _mimeType) {
      await ensureDir()
      if (bytes.length === 0) throw new Error('Refusing to save an empty artifact.')
      if (bytes.length > MAX_ARTIFACT_BYTES) {
        throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit.`)
      }
      const id = `art_${randomBytes(12).toString('hex')}` // currently PNG-only
      const file = safePath(id)
      if (!file) throw new Error('Generated artifact id was rejected by path safety.')
      await fsp.writeFile(path.join(dir, file), bytes)
      logger.info(`Artifact saved: ${id} (${bytes.length} bytes).`)
      return id
    },
    async get(id) {
      const file = safePath(id)
      if (!file) return null
      try {
        const bytes = await fsp.readFile(path.join(dir, file))
        if (bytes.length > MAX_ARTIFACT_BYTES) return null
        return { bytes, mimeType: 'image/png' }
      } catch {
        return null // missing or deleted artifacts read as absent, not errors
      }
    },
    async exists(id) {
      return (await this.get(id)) !== null
    }
  }
}

/** Rejects anything that is not a plain generated id inside artifacts/. */
function safePath(id: string): string | null {
  if (!ARTIFACT_ID_PATTERN.test(id)) return null
  return `${id}.png`
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value)
}
