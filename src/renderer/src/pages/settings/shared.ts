import { getApi } from '../../lib/api'
import type { ClearOverrideKey } from '../../../../shared/contracts'

/** One-liner for a field's "remove saved override" affordance. */
export function clearAndRefreshKeyed(
  key: ClearOverrideKey,
  refresh: () => Promise<void>
): () => void {
  return () => {
    void (async () => {
      await getApi().clearOverride(key)
      await refresh()
    })()
  }
}
