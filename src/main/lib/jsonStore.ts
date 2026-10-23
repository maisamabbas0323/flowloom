import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Logger } from './log'

/**
 * Minimal typed JSON file storage with atomic-ish writes.
 * A corrupted file is backed up (it may contain user data) and defaults
 * are returned instead of crashing the app.
 */
export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly defaults: () => T,
    private readonly logger: Logger
  ) {}

  read(): T {
    try {
      if (!fs.existsSync(this.filePath)) return this.defaults()
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as T
      return { ...this.defaults(), ...parsed }
    } catch (error) {
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`)
      } catch {
        /* nothing worth doing — defaults below still apply */
      }
      this.logger.warn(`Could not read store, using defaults: ${this.filePath}`, error)
      return this.defaults()
    }
  }

  write(value: T): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(tmp, this.filePath)
    } catch (error) {
      this.logger.error(`Could not write store: ${this.filePath}`, error)
    }
  }

  update(mutate: (value: T) => T): T {
    const next = mutate(this.read())
    this.write(next)
    return next
  }
}
