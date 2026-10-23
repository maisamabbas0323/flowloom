import type { Logger } from '../lib/log'
import { JsonStore } from '../lib/jsonStore'
import { isSecretKey, type SecretKey, type SecretStore } from './secretKeys'

/**
 * OS-backed encryption adapter. In production this wraps Electron's
 * safeStorage; tests replace it with a deterministic fake.
 */
export interface SecureStorageAdapter {
  isAvailable(): boolean
  encrypt(plaintext: string): string | null
  decrypt(blob: string): string | null
}

interface VaultFile {
  version: 1
  entries: Partial<Record<SecretKey, { blob: string; updatedAt: string }>>
}

function defaultVaultFile(): VaultFile {
  return { version: 1, entries: {} }
}

/**
 * Credential vault.
 *
 * - When secure OS storage is available, encrypted blobs (never plaintext)
 *   are persisted in the application configuration directory and survive
 *   restarts.
 * - When it is not, credentials are held in memory for the current session
 *   only and explicitly reported as session-scoped — never written to disk
 *   in plaintext.
 * - `.env` files are read by the environment source; the vault never writes
 *   back to them, so user-managed env files are never touched.
 */
export class SecretsVault {
  private readonly store: JsonStore<VaultFile>
  /** Session-only credentials, used when secure storage is unavailable. */
  private readonly sessionOnly = new Map<SecretKey, { value: string; updatedAt: string }>()

  constructor(
    filePath: string,
    private readonly adapter: SecureStorageAdapter,
    private readonly logger: Logger
  ) {
    this.store = new JsonStore<VaultFile>(filePath, defaultVaultFile, logger)
  }

  canPersist(): boolean {
    return this.adapter.isAvailable()
  }

  setSecret(key: SecretKey, plaintext: string): SecretStore {
    const updatedAt = new Date().toISOString()
    if (this.adapter.isAvailable()) {
      const blob = this.adapter.encrypt(plaintext)
      if (blob) {
        this.store.update((file) => {
          file.entries[key] = { blob, updatedAt }
          return file
        })
        return 'disk'
      }
      const failure = 'Secure storage is available but encryption failed; keeping the credential in memory for this session.'
      this.logger.error(failure)
      this.setSession(key, plaintext, updatedAt)
      return 'session'
    }
    this.setSession(key, plaintext, updatedAt)
    return 'session'
  }

  private setSession(key: SecretKey, plaintext: string, updatedAt: string): void {
    this.sessionOnly.set(key, { value: plaintext, updatedAt })
  }

  getSecret(key: SecretKey): { value: string; updatedAt: string } | null {
    const sessionEntry = this.sessionOnly.get(key)
    if (sessionEntry) return { ...sessionEntry }
    const entry = this.store.read().entries[key]
    if (!entry) return null
    const decrypted = this.adapter.decrypt(entry.blob)
    if (!decrypted) {
      // A blob that cannot be decrypted (different OS account, keychain
      // reset…) is effectively a lost credential: drop it and say so.
      this.logger.warn(`Stored credential '${key}' could not be decrypted; dropping it.`)
      this.clearSecret(key)
      return null
    }
    return { value: decrypted, updatedAt: entry.updatedAt }
  }

  clearSecret(key: SecretKey): void {
    this.sessionOnly.delete(key)
    this.store.update((file) => {
      if (isSecretKey(key)) delete file.entries[key]
      return file
    })
  }
}
