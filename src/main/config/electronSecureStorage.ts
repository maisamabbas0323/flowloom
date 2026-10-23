import { safeStorage } from 'electron'
import type { SecureStorageAdapter } from './vault'

/**
 * Electron-backed OS secure storage (keychain / kwallet / DPAPI).
 * `isEncryptionAvailable()` reflects the real OS state — on systems
 * without a helper (e.g. headless Linux without kwallet/gnome-keyring)
 * credential overrides are held in memory for the session only, and the
 * Settings UI explains this instead of silently writing plaintext.
 */
export function createElectronSecureStorage(): SecureStorageAdapter {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext: string) => {
      try {
        return safeStorage.encryptString(plaintext).toString('base64')
      } catch {
        return null
      }
    },
    decrypt: (blob: string) => {
      try {
        const buffer = Buffer.from(blob, 'base64')
        return safeStorage.decryptString(buffer)
      } catch {
        return null
      }
    }
  }
}
