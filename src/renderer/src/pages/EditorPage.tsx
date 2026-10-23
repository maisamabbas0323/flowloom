import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow
} from '@xyflow/react'
import type { Edge, EdgeChange } from '@xyflow/react'
import { CornerDownRight as StartHintIcon, Plus as PlusIcon, FolderOpen as FolderIcon } from 'lucide-react'
import {
  WORKFLOW_SCHEMA_VERSION,
  defaultConfigFor,
  validateWorkflowGraph
} from '../../../shared/nodeSchema'
import type {
  NodeTypeId,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRecord
} from '../../../shared/contracts'
import type { NodeRunStatus, RunStatus } from '../../../shared/runTypes'
import { isTerminalRunStatus } from '../../../shared/runTypes'
import '@xyflow/react/dist/style.css'
import { getApi } from '../lib/api'
import { Button } from '../components/ui/Button'
import { WorkflowCanvas } from '../components/editor/WorkflowCanvas'
import { EditorTopBar } from '../components/editor/EditorTopBar'
import { NodePalette } from '../components/editor/NodePalette'
import { NodeInspector } from '../components/editor/NodeInspector'
import { RunPanel, deriveRunNodes } from '../components/editor/RunPanel'
import type { FlowNode } from '../components/editor/nodeTypes'

/**
 * The editor page: owns the state of the open workflow, the canvas
 * (nodes/edges), the node library, the inspector, undo/redo history,
 * and persistence. Renderer state is ephemeral by design — every
 * committed change flows (debounced) through saveWorkflow IPC so the
 * record on disk always mirrors what the user sees.
 */

type EditorEdge = Edge

/** Live run state tracked for the open workflow. */
interface RunState {
  runId: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  error: string | null
  nodeStatuses: Record<string, NodeRunStatus>
}

interface Snapshot {
  nodes: FlowNode[]
  edges: EditorEdge[]
}

interface ToastState {
  id: number
  tone: 'info' | 'warn' | 'error'
  message: string
}

export function EditorPage(props: {
  workflow: WorkflowRecord | null
  onWorkflowSaved: (record: WorkflowRecord) => void
  onNewWorkflow: () => void
  onOpenWorkflows: () => void
  onOpenRuns: () => void
}) {
  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <ReactFlowProvider>
        <EditorPageInner {...props} />
      </ReactFlowProvider>
    </div>
  )
}

function EditorPageInner({
  workflow,
  onWorkflowSaved,
  onNewWorkflow,
  onOpenWorkflows,
  onOpenRuns
}: {
  workflow: WorkflowRecord | null
  onWorkflowSaved: (record: WorkflowRecord) => void
  onNewWorkflow: () => void
  onOpenWorkflows: () => void
  onOpenRuns: () => void
}) {
  const rf = useReactFlow()
  const [nodes, setNodes] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({
    past: [],
    future: []
  })

  const workflowRef = useRef(workflow)
  const nameRef = useRef(name)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const savedSnapshotRef = useRef('')
  const loadedIdRef = useRef<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const historyTimeRef = useRef(0)
  const lastSavedViewRef = useRef<{ zoom: number; x: number; y: number } | null>(null)
  const viewTimerRef = useRef<number | null>(null)
  workflowRef.current = workflow
  nameRef.current = name
  nodesRef.current = nodes
  edgesRef.current = edges

  /* ---------------------------------------------------------------- */
  /* View ⇄ persisted conversions                                      */
  /* ---------------------------------------------------------------- */

  const toGraphNodes = useCallback((list: FlowNode[]): WorkflowNode[] => {
    return list.map((node) => ({
      id: node.id,
      type: node.data.typeId,
      position: { x: round(node.position.x), y: round(node.position.y) },
      config: node.data.config
    }))
  }, [])

  const toGraphEdges = useCallback((list: EditorEdge[]): WorkflowEdge[] => {
    return list.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {})
    }))
  }, [])

  /** The exact JSON sent to persistence — also the dirty-state source. */
  const persistedJson = useMemo(
    () =>
      JSON.stringify({
        name: name.trim() || workflow?.name || '',
        graph: {
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: toGraphNodes(nodes),
          edges: toGraphEdges(edges)
        }
      }),
    [nodes, edges, name, workflow, toGraphNodes, toGraphEdges]
  )

  const dirty = persistedJson !== savedSnapshotRef.current

  const incompleteCount = useMemo(() => {
    return toGraphNodes(nodes).filter((node) => {
      const result = validateWorkflowGraph({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [node],
        edges: []
      })
      return !result.structural || result.configIssues.some((issue) => issue.nodeId === node.id)
    }).length
  }, [nodes, toGraphNodes])

  /* ---------------------------------------------------------------- */
  /* Persistence                                                       */
  /* ---------------------------------------------------------------- */

  const showToast = useCallback((tone: ToastState['tone'], message: string) => {
    setToast({ id: Date.now() + Math.random(), tone, message })
  }, [])

  const persistRef = useRef(async (): Promise<boolean> => false)

  /** The canvas view right now, rounded for stable persistence. */
  const currentView = useCallback((): { zoom: number; x: number; y: number } => {
    const viewport = rf.getViewport()
    return { zoom: round(viewport.zoom), x: round(viewport.x), y: round(viewport.y) }
  }, [rf])

  const persistNow = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const current = workflowRef.current
    if (!current) return false
    const graph: WorkflowGraph = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: toGraphNodes(nodesRef.current),
      edges: toGraphEdges(edgesRef.current)
    }
    const validation = validateWorkflowGraph(graph)
    if (!validation.structural) {
      showToast('warn', validation.structuralErrors[0] ?? 'The workflow has a structural problem.')
      return false
    }
    setSaving(true)
    try {
      const view = currentView()
      const result = await getApi().saveWorkflow({
        id: current.id,
        name: nameRef.current.trim() || current.name,
        graph,
        view
      })
      if (!result.ok) {
        showToast('error', result.errors[0] ?? 'The workflow could not be saved.')
        return false
      }
      savedSnapshotRef.current = JSON.stringify({ name: nameRef.current.trim() || current.name, graph })
      lastSavedViewRef.current = view
      onWorkflowSaved(result.record)
      window.setTimeout(() => setSavedFlash(true), 0)
      window.setTimeout(() => setSavedFlash(false), 1500)
      const notes = result.configIssues.length
      if (notes > 0) {
        showToast(
          'info',
          `Saved — ${notes} step${notes === 1 ? '' : 's'} still need${notes === 1 ? 's' : ''} setup and will be reported before a run.`
        )
      }
      return true
    } finally {
      setSaving(false)
    }
  }, [onWorkflowSaved, showToast, toGraphNodes, toGraphEdges, currentView])

  /**
   * Saves only a pan/zoom change, without the "Saved" toast/flash: the
   * content is unchanged, but the canvas must reopen exactly where the
   * user left it. Runs only when content is already saved; a pending
   * content change will stay with the normal save pipeline (which
   * includes the view anyway).
   */
  const saveViewSilently = useCallback(async (): Promise<void> => {
    const current = workflowRef.current
    if (!current) return
    const name = nameRef.current.trim() || current.name
    const graph: WorkflowGraph = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: toGraphNodes(nodesRef.current),
      edges: toGraphEdges(edgesRef.current)
    }
    const contentJson = JSON.stringify({ name, graph })
    if (contentJson !== savedSnapshotRef.current) return
    const view = currentView()
    const previous = lastSavedViewRef.current
    if (previous && view.zoom === previous.zoom && view.x === previous.x && view.y === previous.y) return
    try {
      const result = await getApi().saveWorkflow({ id: current.id, name, graph, view })
      if (result.ok) {
        lastSavedViewRef.current = view
        savedSnapshotRef.current = contentJson
      }
    } catch {
      /* a missed view save is retried by the next pan/zoom or save */
    }
  }, [currentView, toGraphNodes, toGraphEdges])

  persistRef.current = persistNow

  const schedulePersist = useCallback((delay = 500) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistRef.current()
    }, delay)
  }, [])

  const scheduleViewPersist = useCallback((delay = 450) => {
    if (viewTimerRef.current !== null) window.clearTimeout(viewTimerRef.current)
    viewTimerRef.current = window.setTimeout(() => {
      viewTimerRef.current = null
      void saveViewSilently()
    }, delay)
  }, [saveViewSilently])

  /* Flush an in-flight save when the editor unmounts (route change or
     app close) so a keystroke is never lost. */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (viewTimerRef.current !== null) window.clearTimeout(viewTimerRef.current)
      void persistRef.current()
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Loading a record into the canvas                                  */
  /* ---------------------------------------------------------------- */

  const load = useCallback(
    (record: WorkflowRecord) => {
      const loadedNodes: FlowNode[] = record.graph.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: { typeId: node.type, config: node.config },
        selected: false
      }))
      const loadedEdges: EditorEdge[] = record.graph.edges.map((edge) => ({ ...edge }))
      setNodes(loadedNodes)
      setEdges(loadedEdges)
      setName(record.name)
      setSelectedNodeId(null)
      setHistory({ past: [], future: [] })
      savedSnapshotRef.current = JSON.stringify({
        name: record.name.trim() || record.name,
        graph: record.graph
      })
      lastSavedViewRef.current = record.view ?? null
      window.setTimeout(() => {
        const savedView = record.view
        // Reopen exactly where the user left it: same zoom, same pan.
        if (savedView && Number.isFinite(savedView.zoom) && savedView.zoom > 0) {
          void rf.setViewport({ zoom: savedView.zoom, x: savedView.x, y: savedView.y })
        } else {
          void rf.fitView({ padding: 0.3, duration: 180, maxZoom: 1 })
        }
      }, 60)
    },
    [rf, setNodes, setEdges]
  )

  useEffect(() => {
    if (!workflow) return
    if (workflow.id === loadedIdRef.current) return
    loadedIdRef.current = workflow.id
    load(workflow)
  }, [workflow, load])

  /* A workflow deleted from the workspace must vanish from the editor
     too — the record is already gone on disk, so the canvas clears
     instead of showing a phantom project that can no longer save. */
  useEffect(() => {
    if (workflow) return
    loadedIdRef.current = null
    setNodes([])
    setEdges([])
    setName('')
    setSelectedNodeId(null)
    setHistory({ past: [], future: [] })
    savedSnapshotRef.current = ''
    lastSavedViewRef.current = null
  }, [workflow, setNodes, setEdges])

  /* ---------------------------------------------------------------- */
  /* History (undo / redo)                                             */
  /* ---------------------------------------------------------------- */

  const pushHistory = useCallback(() => {
    const now = Date.now()
    setHistory((prev) => {
      const past = prev.past.slice(-40)
      // Coalesce bursts (typing) so undo stays step-wise meaningful.
      if (now - historyTimeRef.current < 700) {
        historyTimeRef.current = now
        return { ...prev, past }
      }
      historyTimeRef.current = now
      return {
        past: [...past, { nodes: nodesRef.current, edges: edgesRef.current }],
        future: []
      }
    })
  }, [])

  const undo = useCallback(() => {
    setHistory((prev) => {
      const previous = prev.past[prev.past.length - 1]
      if (!previous) return prev
      setNodes(previous.nodes)
      setEdges(previous.edges)
      setSelectedNodeId((id) => (previous.nodes.some((n) => n.id === id) ? id : null))
      schedulePersist(60)
      return {
        past: prev.past.slice(0, -1),
        future: [...prev.future, { nodes: nodesRef.current, edges: edgesRef.current }]
      }
    })
  }, [setNodes, setEdges, schedulePersist])

  const redo = useCallback(() => {
    setHistory((prev) => {
      const next = prev.future[prev.future.length - 1]
      if (!next) return prev
      setNodes(next.nodes)
      setEdges(next.edges)
      setSelectedNodeId((id) => (next.nodes.some((n) => n.id === id) ? id : null))
      schedulePersist(60)
      return {
        past: [...prev.past, { nodes: nodesRef.current, edges: edgesRef.current }],
        future: prev.future.slice(0, -1)
      }
    })
  }, [setNodes, setEdges, schedulePersist])

  /* ---------------------------------------------------------------- */
  /* Node + edge operations                                            */
  /* ---------------------------------------------------------------- */

  const findFreePosition = useCallback((start: { x: number; y: number }) => {
    const position = { x: round(start.x), y: round(start.y) }
    const existing = nodesRef.current
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const overlaps = existing.some(
        (node) => Math.abs(node.position.x - position.x) < 32 && Math.abs(node.position.y - position.y) < 40
      )
      if (!overlaps) return position
      position.x = round(position.x + 36)
      position.y = round(position.y + 28)
    }
    return position
  }, [])

  const addNode = useCallback(
    (typeId: NodeTypeId, position?: { x: number; y: number }) => {
      const finalPosition = findFreePosition(position ?? centerFlowPosition(rf))
      const id = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const node: FlowNode = {
        id,
        type: typeId,
        position: finalPosition,
        data: { typeId, config: defaultConfigFor(typeId) },
        selected: true
      }
      pushHistory()
      setNodes((current) => [
        ...current.map((n) => (n.selected ? { ...n, selected: false } : n)),
        node
      ])
      setSelectedNodeId(id)
      setLibraryOpen(false)
      schedulePersist(80)
    },
    [findFreePosition, pushHistory, rf, setNodes, schedulePersist]
  )

  const removeNode = useCallback(
    (nodeId: string) => {
      pushHistory()
      setNodes((current) => current.filter((n) => n.id !== nodeId))
      setEdges((current) => current.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedNodeId((id) => (id === nodeId ? null : id))
      schedulePersist(80)
    },
    [pushHistory, setNodes, setEdges, schedulePersist]
  )

  const deleteSelection = useCallback(() => {
    const selectedNodes = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    const selectedEdges = edgesRef.current.filter((e) => e.selected)
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return
    pushHistory()
    if (selectedNodes.length > 0) {
      const doomed = new Set(selectedNodes)
      setNodes((current) => current.filter((n) => !doomed.has(n.id)))
      setEdges((current) => current.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)))
    }
    if (selectedEdges.length > 0) {
      const doomed = new Set(selectedEdges.map((e) => e.id))
      setEdges((current) => current.filter((e) => !doomed.has(e.id)))
    }
    setSelectedNodeId(null)
    schedulePersist(80)
  }, [pushHistory, setNodes, setEdges, schedulePersist])

  const connectNodes = useCallback(
    (connection: { source: string; target: string; sourceHandle?: string | null }) => {
      pushHistory()
      const edge: EditorEdge = {
        id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        source: connection.source,
        target: connection.target,
        ...(connection.sourceHandle ? { sourceHandle: connection.sourceHandle } : {})
      }
      setEdges((current) => [...current.map((e) => ({ ...e, selected: false })), edge])
      schedulePersist(80)
    },
    [pushHistory, setEdges, schedulePersist]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes)
      if (changes.some((change) => change.type === 'remove')) {
        pushHistory()
        schedulePersist(80)
      }
    },
    [onEdgesChange, pushHistory, schedulePersist]
  )

  const handleConfigChange = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selectedNodeId) return
      pushHistory()
      const nodeId = selectedNodeId
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } }
            : node
        )
      )
      schedulePersist(600)
    },
    [selectedNodeId, pushHistory, setNodes, schedulePersist]
  )

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  )

  /* Deselect when the selected node disappears (removed or undone). */
  useEffect(() => {
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null)
    }
  }, [nodes, selectedNodeId])

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inField = Boolean(target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (event.key === 'Escape' && !inField) {
        if (libraryOpen) {
          setLibraryOpen(false)
        } else if (selectedNodeId) {
          setSelectedNodeId(null)
        }
        return
      }
      if (inField) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [libraryOpen, selectedNodeId, undo, redo])

  /* Toast lifecycle */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4600)
    return () => window.clearTimeout(timer)
  }, [toast])

  /* ---------------------------------------------------------------- */
  /* Execution: live run state from the main-process engine            */
  /* ---------------------------------------------------------------- */

  const [run, setRun] = useState<RunState | null>(null)
  const [starting, setStarting] = useState(false)
  const runRef = useRef<RunState | null>(null)
  runRef.current = run

  const isRunActivity = (status: RunStatus): boolean =>
    status === 'queued' || status === 'validating' || status === 'running' || status === 'cancelling'

  useEffect(() => {
    const workflowId = workflow?.id
    if (!workflowId) {
      setRun(null)
      return
    }
    let disposed = false
    // Adopt a run still executing in the main process (e.g. the editor
    // was closed while the run continued, or the app was reopened).
    void (async () => {
      try {
        const summaries = await getApi().listRuns()
        if (disposed) return
        const ours = summaries.find(
          (summary) => summary.workflowId === workflowId && !isTerminalRunStatus(summary.status)
        )
        if (ours) {
          setRun((prev) =>
            prev ?? {
              runId: ours.id,
              status: ours.status,
              startedAt: ours.startedAt,
              finishedAt: null,
              error: ours.error,
              nodeStatuses: {}
            }
          )
        }
      } catch {
        /* listing is best-effort; the next event will reconcile */
      }
    })()

    /** Ignores stale events: a live tracked run never adopts a new one. */
    const keepLive = (prev: RunState | null, runId: string): RunState | null => {
      if (prev !== null && prev.runId !== runId && isRunActivity(prev.status)) return prev
      return null
      // null means "not keeping the old run" — caller adopts the event.
    }

    const unsubscribe = getApi().onRunEvent((event) => {
      if (disposed) return
      if (event.workflowId !== workflowId) return

      const stale = keepLive(runRef.current, event.runId)
      const tolerateStaleNodeEvent =
        event.type === 'node' && runRef.current !== null && runRef.current.runId !== event.runId && isRunActivity(runRef.current.status)
      if (stale !== null || tolerateStaleNodeEvent) return

      if (event.type === 'workflow') {
        setRun((prev) => {
          const terminal = isTerminalRunStatus(event.status)
          const base = prev ?? {
            runId: event.runId,
            status: event.status,
            startedAt: event.at,
            finishedAt: null,
            error: null,
            nodeStatuses: {} as Record<string, NodeRunStatus>
          }
          return {
            ...base,
            runId: event.runId,
            status: event.status,
            startedAt: prev === null || terminal || event.status === 'cancelling' ? base.startedAt : event.at,
            finishedAt: terminal ? event.at : null,
            error:
              event.status === 'cancelling' || terminal ? (event.message ?? base.error) : base.error
          }
        })
        return
      }
      // Node event — statuses drive both the canvas and the panel.
      setNodes((current) =>
        current.map((node) =>
          node.id === event.nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  runStatus: event.status,
                  stage: event.message ?? node.data.stage
                }
              }
            : node
        )
      )
      setRun((prev) => {
        const base = prev ?? {
          runId: event.runId,
          status: 'running' as RunStatus,
          startedAt: event.at,
          finishedAt: null,
          error: null,
          nodeStatuses: {} as Record<string, NodeRunStatus>
        }
        return {
          ...base,
          runId: event.runId,
          status: base.status,
          nodeStatuses: { ...base.nodeStatuses, [event.nodeId]: event.status }
        }
      })
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [workflow?.id, setNodes])

  const handleStartRun = useCallback(async () => {
    const current = workflowRef.current
    if (!current) return
    setStarting(true)
    try {
      // Previous run tinting must not leak into the new run's canvas.
      setNodes((existing) =>
        existing.map((node) =>
          node.data.runStatus ? { ...node, data: { ...node.data, runStatus: undefined, stage: undefined } } : node
        )
      )
      // The engine executes what is persisted — save first so the run
      // matches exactly what the user sees. Failure to save is honest:
      // no run starts.
      const saved = await persistNow()
      if (!saved) return
      const result = await getApi().startRun(current.id)
      if (!result.ok) {
        showToast('error', result.errors.join('\n').trim())
        return
      }
      setRun((prev) =>
        prev ?? {
          runId: result.runId,
          status: 'queued',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          error: null,
          nodeStatuses: {}
        }
      )
    } finally {
      setStarting(false)
    }
  }, [persistNow, showToast])

  const handleCancelRun = useCallback(() => {
    const current = runRef.current
    if (!current) return
    void getApi().cancelRun(current.runId)
  }, [])

  const runPanelState = useMemo(() => {
    if (!run) return null
    return {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      nodes: deriveRunNodes(new Map(Object.entries(run.nodeStatuses)), nodes)
    }
  }, [run, nodes])


  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <>
      <EditorTopBar
        name={name}
        hasWorkflow={Boolean(workflow)}
        dirty={dirty}
        saving={saving}
        savedFlash={savedFlash}
        libraryOpen={libraryOpen}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        incompleteCount={incompleteCount}
        runStatus={run?.status ?? null}
        starting={starting}
        onNameChange={(value) => {
          setName(value)
          schedulePersist(700)
        }}
        onNameCommit={() => schedulePersist(50)}
        onNameReset={() => setName(workflow?.name ?? '')}
        onToggleLibrary={() => setLibraryOpen((open) => !open)}
        onUndo={undo}
        onRedo={redo}
        onStartRun={() => void handleStartRun()}
        onCancelRun={handleCancelRun}
        onSave={() => void persistNow()}
      />
      <div className="relative min-h-0 flex-1">
        <WorkflowCanvas
          nodes={nodes}
          edges={edges}
          readOnly={!workflow}
          onNodesChange={(changes) => setNodes((current) => applyNodeChanges<FlowNode>(changes, current))}
          onEdgesChange={handleEdgesChange}
          onDragStart={pushHistory}
          onConnect={(connection) => connectNodes(connection)}
          onMoveEnd={() => scheduleViewPersist()}
          onDragStop={() => {
            schedulePersist(60)
          }}
          onNodeClick={(nodeId) => {
            setSelectedNodeId(nodeId)
            setLibraryOpen(false)
          }}
          onEdgeClick={() => setSelectedNodeId(null)}
          onPaneInteraction={() => {
            setSelectedNodeId(null)
            setLibraryOpen(false)
          }}
          onDropType={(typeId, position) => addNode(typeId, position)}
          onInvalidDrop={(reason) => showToast('warn', reason)}
          onDeleteSelection={deleteSelection}
          zoomIn={() => {
            void rf.zoomIn({ duration: 140 })
            scheduleViewPersist()
          }}
          zoomOut={() => {
            void rf.zoomOut({ duration: 140 })
            scheduleViewPersist()
          }}
          fitView={() => {
            void rf.fitView({ padding: 0.3, duration: 180, maxZoom: 1 })
            scheduleViewPersist()
          }}
        />

        {workflow && nodes.length === 0 && !libraryOpen ? (
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-xl border border-[#e3e4e8] bg-white px-4 py-3 text-[12.5px] text-[#6f707a] shadow-[0_2px_12px_rgba(20,20,24,0.06)] transition-colors hover:border-[#cbccd3] hover:text-[#1c1d21]"
          >
            <StartHintIcon size={14} strokeWidth={2} />
            Start with a trigger from the node library
          </button>
        ) : null}

        {workflow && libraryOpen ? (
          <NodePalette
            onPick={(typeId) => addNode(typeId)}
            onDragStartType={(typeId, event) => {
              event.dataTransfer.setData('application/flowloom-node', typeId)
              event.dataTransfer.effectAllowed = 'copy'
            }}
            onClose={() => setLibraryOpen(false)}
          />
        ) : null}

        {selectedNode ? (
          <NodeInspector
            node={selectedNode}
            onConfigChange={handleConfigChange}
            onDelete={removeNode}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : null}

        {toast ? (
          <div
            key={toast.id}
            role="status"
            className={
              'absolute bottom-3 left-1/2 z-30 max-w-[520px] -translate-x-1/2 whitespace-pre-line rounded-lg border px-3.5 py-2 text-[12px] leading-relaxed shadow-[0_6px_20px_rgba(20,20,24,0.12)] ' +
              (toast.tone === 'error'
                ? 'border-[#e6d5d7] bg-white text-[#c22f3d]'
                : toast.tone === 'warn'
                  ? 'border-[#ecdcc4] bg-[#fbf6ec] text-[#7a5a24]'
                  : 'border-[#e3e4e8] bg-white text-[#3d3e45]')
            }
          >
            {toast.message}
          </div>
        ) : null}

        {runPanelState ? (
          <RunPanel
            run={runPanelState}
            onCancel={handleCancelRun}
            onOpenHistory={onOpenRuns}
            onFocusNode={(nodeId) => {
              setSelectedNodeId(nodeId)
              setLibraryOpen(false)
            }}
          />
        ) : null}
      </div>

      {!workflow ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#fafafa]">
          <div className="flex max-w-[440px] flex-col items-center rounded-2xl border border-[#e9e9ee] bg-white px-8 py-7 text-center shadow-[0_4px_24px_rgba(20,20,24,0.06)]">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-[#e9e9ee] bg-[#fafafa] text-[#5d5e66]">
              <FolderIcon size={20} strokeWidth={1.8} />
            </div>
            <h2 className="text-[15.5px] font-semibold tracking-tight text-[#1c1d21]">
              Open a workflow to start weaving
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8b8c95]">
              A workflow is a living record: a trigger, browser steps, waits and decisions —
              wired together on this canvas and saved on this machine.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <Button variant="primary" onClick={onNewWorkflow}>
                <PlusIcon size={14} strokeWidth={2.2} />
                New workflow
              </Button>
              <Button variant="secondary" onClick={onOpenWorkflows}>
                Open existing
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/* -------------------------------------------------------------------- */
/* Small helpers                                                        */
/* -------------------------------------------------------------------- */

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function centerFlowPosition(rf: ReturnType<typeof useReactFlow>): { x: number; y: number } {
  const viewport = rf.getViewport()
  const container = document.querySelector<HTMLElement>('.react-flow') ?? null
  const width = container?.clientWidth ?? 800
  const height = container?.clientHeight ?? 500
  return {
    x: round((-viewport.x + width / 2) / viewport.zoom - 104),
    y: round((-viewport.y + height / 2) / viewport.zoom - 30)
  }
}
