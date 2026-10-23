import { useCallback, useEffect, useState } from 'react'
import type { AppConfigView } from '../../../shared/contracts'
import { getApi } from '../lib/api'

/**
 * Application-wide configuration state. One load, one refresh entry
 * point; saving screens call `refresh` after successful mutations. A
 * failed load is treated as an environment problem and reported.
 */
export interface ConfigState {
  config: AppConfigView | null
  error: string | null
  loading: boolean
  refresh: () => Promise<void>
}

export function useAppConfig(): ConfigState {
  const [config, setConfig] = useState<AppConfigView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const api = getApi()
      const next = await api.getConfig()
      setConfig(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load configuration.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { config, error, loading, refresh }
}
