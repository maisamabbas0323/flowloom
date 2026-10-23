import { useCallback, useEffect, useState } from 'react'
import {
  NavRail,
  type Route
} from './components/shell/NavRail'
import { EditorPage } from './pages/EditorPage'
import { WorkflowsPage } from './pages/WorkflowsPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { useAppConfig } from './state/useAppConfig'
import { NarrationPlayer } from './components/shell/NarrationPlayer'
import { getApi } from './lib/api'
import type { WorkflowRecord } from '../../shared/contracts'

export default function App() {
  const { config, error, loading, refresh } = useAppConfig()
  const [route, setRoute] = useState<Route>('editor')
  const [workflow, setWorkflow] = useState<WorkflowRecord | null>(null)
  const [workflowsVersion, setWorkflowsVersion] = useState(0)

  const openWorkflow = useCallback(async (id: string) => {
    const record = await getApi().getWorkflow(id)
    setWorkflow(record)
    setRoute('editor')
  }, [])

  const newWorkflow = useCallback(async () => {
    const record = await getApi().createWorkflow({ name: 'Untitled workflow' })
    if (record) setWorkflow(record)
    setWorkflowsVersion((v) => v + 1)
    setRoute('editor')
  }, [])

  // Reopen the most recently opened workflow when the app starts, if the
  // user asked for it in Settings.
  useEffect(() => {
    if (!config || workflow) return
    if (!config.general.reopenLastWorkflow.enabled) return
    let cancelled = false
    void (async () => {
      const list = await getApi().listWorkflows()
      const mostRecent = list
        .filter((wf) => wf.lastOpenedAt)
        .sort((a, b) => ((a.lastOpenedAt ?? '') < (b.lastOpenedAt ?? '') ? 1 : -1))[0]
      if (!mostRecent || cancelled) return
      const record = await getApi().getWorkflow(mostRecent.id)
      if (!cancelled && record) setWorkflow(record)
    })()
    return () => {
      cancelled = true
    }
  }, [config, workflow])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <NarrationPlayer />
      <NavRail active={route} onNavigate={setRoute} />
      <main className="flex min-w-0 flex-1 flex-col bg-[#fafafa]">
        {route === 'editor' ? (
          <EditorPage
            workflow={workflow}
            onWorkflowSaved={(record) => {
              setWorkflow(record)
              setWorkflowsVersion((v) => v + 1)
            }}
            onNewWorkflow={newWorkflow}
            onOpenWorkflows={() => setRoute('workflows')}
            onOpenRuns={() => setRoute('history')}
          />
        ) : null}
        {route === 'workflows' ? (
          <WorkflowsPage
            version={workflowsVersion}
            onOpen={openWorkflow}
            onNewWorkflow={newWorkflow}
            onDeleted={(id) => {
              // A deleted workflow must disappear from the editor too.
              setWorkflow((current) => (current && current.id === id ? null : current))
            }}
          />
        ) : null}
        {route === 'history' ? <HistoryPage /> : null}
        {route === 'settings' ? (
          <SettingsPage
            config={config}
            configError={error}
            loading={loading}
            onRefresh={refresh}
          />
        ) : null}
      </main>
    </div>
  )
}