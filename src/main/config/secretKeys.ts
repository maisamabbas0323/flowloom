/**
 * Keys under which credentials may live in the vault.
 * These are internal identifiers only — no secret material.
 */
export const SECRET_KEYS = [
  'googleApiKey',
  'openrouterApiKey',
  'ollamaApiKey',
  'elevenlabsApiKey',
  'browserbaseApiKey',
  'paperinstrumentsApiKey'
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

export function isSecretKey(value: string): value is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(value)
}

/** Where a stored credential currently lives. */
export type SecretStore = 'disk' | 'session'
