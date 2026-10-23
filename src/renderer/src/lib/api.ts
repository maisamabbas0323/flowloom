/**
 * Thin wrapper around the preload bridge. All renderer access to main
 * goes through this module so the security boundary stays in one place.
 * Import `ensureApi()` once at startup; it fails loudly if the bridge is
 * missing (which would mean the preload script did not run).
 */
import type { FlowloomApi } from '../../../preload/api'

let apiInstance: FlowloomApi | null = null

export function getApi(): FlowloomApi {
  if (apiInstance) return apiInstance
  const api = (window as unknown as { flowloom?: FlowloomApi }).flowloom
  if (!api) {
    throw new Error('Flowloom bridge unavailable — the preload script failed to run.')
  }
  apiInstance = api
  return api
}
