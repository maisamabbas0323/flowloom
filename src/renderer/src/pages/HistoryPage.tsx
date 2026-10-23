import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  History as HistoryIcon,
  ChevronLeft as ChevronLeftIcon,
  RefreshCw as RefreshIcon,
  CircleCheck as CircleCheckIcon,
  CircleX as CircleXIcon,
  CircleMinus as CircleMinusIcon,
  LoaderCircle as LoaderCircleIcon,
  CircleSlash as CircleSlashIcon,
  Circle as CircleIcon,
  Zap as ZapIcon,
  Trash2 as TrashIcon,
  Search as SearchIcon,
  ImageIcon
} from 'lucide-react'
import type { NodeRunStatus, RunRecord, RunStatus, RunSummary } from '../../../shared/runTypes'
import { isTerminalRunStatus } from '../../../shared/runTypes'
import { getNodeType } from '../../../shared/nodeSchema'
import { Page } from './WorkflowsPage'
import { EmptyState } from '../components/ui/Micro'
import { Button, IconButton } from '../components/ui/Button'
import { TextInput } from '../components/ui/TextInput'
import { getApi } from '../lib/api'
import { cn } from '../lib/cn'

/** Mirrors the main-process artifact id format (generated ids only). */
const ARTIFACT_ID_RE = /^art_[a-z0-9]{24}$/

type StatusFilter = 'all' | 'active' | 'succeeded' | 'failed' | 'cancelled'

function isActiveStatus(status: RunStatus): boolean {
  return !isTerminalRunStatus(status)
}

function matchesFilter(run: RunSummary, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return isActiveStatus(run.status)
  return run.status === filter
}

/**
 * Run history: every persisted run, newest first, with a node-level
 * detail view. The list comes from the main process run store — never
 * from mock data — and an empty history is shown truthfully ("runs
 * you execute from the editor will appear here"). Individual records
 * and the whole history can be deleted for good (real files on disk,
 * removed through the main process).
 */
export function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const summaries = await getApi().listRuns()
        if (!disposed) setRuns(summaries)
      } catch {
        if (!disposed) setRuns([])
      }
    })()
    return () => {
      disposed = true
    }
  }, [reloadKey])

  // Live-subscribe so active runs flip to their terminal state here too.
  useEffect(() => {
    const unsubscribe = getApi().onRunEvent((event) => {
      if (event.type === 'workflow' && isTerminalRunStatus(event.status)) {
        setReloadKey((key) => key + 1)
      }
    })
    return unsubscribe
  }, [])

  // Notices ("history cleared") fade on their own.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const counts = useMemo(() => {
    const base = { total: 0, active: 0, succeeded: 0, failed: 0, cancelled: 0 }
    for (const run of runs ?? []) {
      base.total += 1
      if (isActiveStatus(run.status)) base.active += 1
      else if (run.status === 'succeeded') base.succeeded += 1
      else if (run.status === 'failed') base.failed += 1
      else if (run.status === 'cancelled') base.cancelled += 1
    }
    return base
  }, [runs])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (runs ?? []).filter((run) => {
      if (!matchesFilter(run, statusFilter)) return false
      if (needle === '') return true
      return (
        run.workflowName.toLowerCase().includes(needle) || run.id.toLowerCase().includes(needle)
      )
    })
  }, [runs, query, statusFilter])

  const clearHistory = async () => {
    setClearing(true)
    try {
      const removed = await getApi().clearRunHistory()
      setConfirmingClear(false)
      setNotice(
        removed === 0
          ? 'Run history was already empty.'
          : `Cleared ${removed} run${removed === 1 ? '' : 's'} from this machine.`
      )
      reload()
    } finally {
      setClearing(false)
    }
  }

  const deleteRun = async (id: string) => {
    setDeletingId(id)
    try {
      await getApi().deleteRun(id)
      setDeletingId(null)
      reload()
    } catch {
      setDeletingId(null)
      setNotice('The run record could not be deleted.')
    }
  }

  if (selectedId) {
    return (
      <RunDetailPage
        runId={selectedId}
        onBack={() => setSelectedId(null)}
        onDeleted={() => {
          setSelectedId(null)
          setNotice('The run record was deleted.')
          reload()
        }}
      />
    )
  }

  const filters: Array<{ id: StatusFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.total },
    { id: 'active', label: 'Running', count: counts.active },
    { id: 'succeeded', label: 'Succeeded', count: counts.succeeded },
    { id: 'failed', label: 'Failed', count: counts.failed },
    { id: 'cancelled', label: 'Cancelled', count: counts.cancelled }
  ]

  return (
    <Page
      title="Run history"
      subtitle="Every run of your workflows, newest first."
      actions={
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={reload}
            className="flex items-center gap-1.5 rounded-lg border border-[#e6e6ea] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#5d5e66] shadow-[0_1px_2px_rgba(20,20,24,0.05)] transition-colors hover:border-[#cbccd3] hover:text-[#1c1d21]"
          >
            <RefreshIcon size={13} strokeWidth={2} />
            Refresh
          </button>
          {confirmingClear ? (
            <span className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e6d5d7] bg-[#fdf7f8] px-2 py-1">
              <span className="text-[11.5px] text-[#5d5e66]">
                Delete all {counts.total} run{counts.total === 1 ? '' : 's'}?
              </span>
              <Button size="sm" variant="danger-ghost" busy={clearing} onClick={() => void clearHistory()}>
                Delete all
              </Button>
              <Button size="sm" variant="ghost" disabled={clearing} onClick={() => setConfirmingClear(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="danger-ghost"
              disabled={counts.total === 0 || counts.active > 0}
              title={
                counts.active > 0
                  ? 'A run is still in progress — clear history once it finishes.'
                  : counts.total === 0
                    ? 'There is nothing to clear yet.'
                    : 'Delete every stored run record from this machine'
              }
              onClick={() => setConfirmingClear(true)}
            >
              <TrashIcon size={13} strokeWidth={2} />
              Clear history
            </Button>
          )}
        </span>
      }
    >
      {notice ? (
        <p className="mx-auto mb-2 w-full max-w-[720px] rounded-lg border border-[#dde0f4] bg-[#eef0fb] px-3 py-2 text-[12px] text-[#3f4cc0]">
          {notice}
        </p>
      ) : null}
      {runs === null ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[#8b8c95]">
          <LoaderCircleIcon size={15} strokeWidth={2} className="mr-2 animate-spin" />
          Loading runs…
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<HistoryIcon size={20} strokeWidth={1.8} />}
            title="No runs yet"
            description="Open a workflow in the editor and press Run. Trigger, text, delay, condition, join, browser and model steps execute for real — every run, with its full outcome, is recorded here."
            compact
          />
        </div>
      ) : (
        <>
          <div className="mx-auto flex w-full max-w-[720px] flex-wrap items-center gap-2">
            <div className="relative min-w-[170px] max-w-[280px] flex-1">
              <SearchIcon
                size={13}
                strokeWidth={2}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a2a3ac]"
              />
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search workflow or run id"
                aria-label="Search runs"
                className="pl-8"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {filters.map((filter) => {
                if (filter.id !== 'all' && filter.count === 0) return null
                const activeChip = statusFilter === filter.id
                return (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={activeChip}
                    onClick={() => setStatusFilter(filter.id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                      activeChip
                        ? 'border-[#c9cdf0] bg-[#eef0fb] text-[#3f4cc0]'
                        : 'border-[#e6e6ea] bg-white text-[#6f707a] hover:border-[#cbccd3] hover:text-[#1c1d21]'
                    )}
                  >
                    {filter.label}
                    <span
                      className={cn(
                        'rounded-full px-1 text-[10.5px] tabular-nums',
                        activeChip ? 'bg-[#dfe3f8] text-[#3f4cc0]' : 'bg-[#f4f4f5] text-[#8b8c95]'
                      )}
                    >
                      {filter.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={<SearchIcon size={19} strokeWidth={1.8} />}
                title="No runs match your filters"
                description="Try a different search text, or switch back to the full list."
                compact
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setQuery('')
                      setStatusFilter('all')
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <RunList
              runs={filtered}
              onOpen={(id) => setSelectedId(id)}
              confirmingId={deletingId}
              onAskDelete={(id) => setDeletingId(id)}
              onCancelDelete={() => setDeletingId(null)}
              onConfirmDelete={(id) => void deleteRun(id)}
            />
          )}
        </>
      )}
    </Page>
  )
}

function RunList({
  runs,
  onOpen,
  confirmingId,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete
}: {
  runs: RunSummary[]
  onOpen: (id: string) => void
  /** The run whose delete is awaiting confirmation (also the busy row). */
  confirmingId: string | null
  onAskDelete: (id: string) => void
  onCancelDelete: () => void
  onConfirmDelete: (id: string) => void
}) {
  return (
    <ul className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
      {runs.map((run) => {
        if (confirmingId === run.id) {
          return (
            <li
              key={run.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e6d5d7] bg-[#fdf7f8] px-4 py-3"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#5d5e66]">
                Delete the run of “{run.workflowName}” for good?
              </span>
              <Button
                size="sm"
                variant="danger-ghost"
                busy
                onClick={() => onConfirmDelete(run.id)}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancelDelete}>
                Keep
              </Button>
            </li>
          )
        }
        const busy = confirmingId !== null
        const active = isActiveStatus(run.status)
        return (
          <li key={run.id}>
            <div className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-[#e6e6ea] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(20,20,24,0.04)] transition-colors hover:border-[#cbccd3]">
              <button
                type="button"
                onClick={() => onOpen(run.id)}
                className="flex min-w-[200px] flex-1 items-center gap-3 text-left"
              >
                <RunStatusBadge status={run.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold tracking-tight text-[#1c1d21]">
                    {run.workflowName}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-[11.5px] text-[#8b8c95]"
                    title={formatTimestamp(run.startedAt)}
                  >
                    {formatRelative(run.startedAt)}
                    {run.durationMs !== null
                      ? ` · took ${formatDuration(run.durationMs)}`
                      : active
                        ? ' · still running'
                        : ''}
                  </span>
                  {run.error ? (
                    <span className="mt-0.5 block truncate text-[11.5px] text-[#c22f3d]">
                      {run.error}
                    </span>
                  ) : null}
                </span>
                <span
                  className="hidden shrink-0 text-[11px] tabular-nums text-[#a2a3ac] md:block"
                  title={run.id}
                >
                  {run.id}
                </span>
              </button>
              <IconButton
                label={
                  active
                    ? 'A running workflow keeps writing its record — delete it after it finishes'
                    : 'Delete this run record'
                }
                disabled={active || busy}
                className="text-[#8b8c95] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onAskDelete(run.id)}
              >
                <TrashIcon size={14} strokeWidth={2} />
              </IconButton>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function RunStatusBadge({ status }: { status: RunSummary['status'] }) {
  const active = isActiveStatus(status)
  const { Icon } = badgeVisual(status)
  return (
    <span
      className={cn(
        'flex w-[104px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize',
        active
          ? 'border-[#dde0f4] bg-[#eef0fb] text-[#3f4cc0]'
          : status === 'succeeded'
            ? 'border-[#d5e8d9] bg-[#f0f8f2] text-[#157f3d]'
            : status === 'failed'
              ? 'border-[#e9d5d8] bg-[#fbf0f1] text-[#c22f3d]'
              : 'border-[#ecdcc4] bg-[#fbf6ec] text-[#7a5a24]'
      )}
    >
      <Icon size={12} strokeWidth={2.2} className={cn(active && 'animate-spin motion-reduce:animate-none')} />
      {status}
    </span>
  )
}

function badgeVisual(status: RunSummary['status']): { Icon: typeof CircleIcon } {
  switch (status) {
    case 'succeeded':
      return { Icon: CircleCheckIcon }
    case 'failed':
      return { Icon: CircleXIcon }
    case 'cancelled':
      return { Icon: CircleMinusIcon }
    default:
      return { Icon: LoaderCircleIcon }
  }
}

/* ------------------------------------------------------------------ */
/* Run detail                                                          */
/* ------------------------------------------------------------------ */

function RunDetailPage({
  runId,
  onBack,
  onDeleted
}: {
  runId: string
  onBack: () => void
  onDeleted: () => void
}) {
  const [run, setRun] = useState<RunRecord | null>(null)
  const [missing, setMissing] = useState(false)
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const record = await getApi().getRun(runId)
      if (record) setRun(record)
      else setMissing(true)
    } catch {
      setMissing(true)
    }
  }, [runId])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async () => {
    setDeleting(true)
    try {
      await getApi().deleteRun(runId)
      onDeleted()
    } finally {
      setDeleting(false)
    }
  }

  if (missing) {
    return (
      <Page title="Run details" subtitle="">
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<HistoryIcon size={20} strokeWidth={1.8} />}
            title="This run is no longer available"
            description="The record was deleted, removed as history rotated past its retention limit, or the run could not be read from disk."
            compact
          />
        </div>
      </Page>
    )
  }

  if (!run) {
    return (
      <Page title="Run details" subtitle="">
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[#8b8c95]">
          <LoaderCircleIcon size={16} strokeWidth={2} className="mr-2 animate-spin" />
          Loading run…
        </div>
      </Page>
    )
  }

  const runActive = isActiveStatus(run.status)

  return (
    <Page title="Run details" subtitle={run.workflowName}>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-[#5d5e66] transition-colors hover:bg-[#f6f6f8] hover:text-[#1c1d21]"
          >
            <ChevronLeftIcon size={14} strokeWidth={2} />
            All runs
          </button>
          <span className="flex-1" />
          {confirmingDelete ? (
            <span className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e6d5d7] bg-[#fdf7f8] px-2 py-1">
              <span className="text-[11.5px] text-[#5d5e66]">Delete this run record?</span>
              <Button size="sm" variant="danger-ghost" busy={deleting} onClick={() => void remove()}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="danger-ghost"
              disabled={runActive}
              title={
                runActive
                  ? 'This run is still in progress — delete it after it finishes.'
                  : 'Delete this run record from this machine'
              }
              onClick={() => setConfirmingDelete(true)}
            >
              <TrashIcon size={13} strokeWidth={2} />
              Delete run
            </Button>
          )}
        </div>

        <div className="rounded-xl border border-[#e6e6ea] bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(20,20,24,0.04)]">
          <div className="flex flex-wrap items-center gap-2.5">
            <RunStatusBadge status={run.status} />
            <span className="text-[12px] text-[#8b8c95]">
              Started {formatTimestamp(run.startedAt)}
              {run.finishedAt ? ` · finished ${formatTimestamp(run.finishedAt)}` : ''}
            </span>
          </div>
          {run.durationMs !== null ? (
            <p className="mt-1 text-[12px] text-[#8b8c95]">Elapsed time: {formatDuration(run.durationMs)}</p>
          ) : null}
          {run.error ? (
            <p className="mt-2 rounded-md border border-[#e9d5d8] bg-[#fbf0f1] px-2.5 py-2 text-[12px] leading-relaxed text-[#c22f3d]">
              {run.error}
            </p>
          ) : null}
        </div>

        <h2 className="mt-1 text-[12.5px] font-semibold tracking-tight text-[#1c1d21]">Execution timeline</h2>
        <ul className="flex flex-col gap-1.5">
          {run.nodes.map((node) => {
            const open = openNodeId === node.nodeId
            return (
              <li key={node.nodeId}>
                <div className="rounded-xl border border-[#e6e6ea] bg-white shadow-[0_1px_2px_rgba(20,20,24,0.04)]">
                  <button
                    type="button"
                    onClick={() => setOpenNodeId(open ? null : node.nodeId)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
                  >
                    <NodeStateDot status={node.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-[#1c1d21]">{node.title}</span>
                      <span className="block truncate text-[11px] text-[#a2a3ac]">
                        {getNodeType(node.nodeType).label} · {node.status}
                        {node.durationMs !== null ? ` · ${formatDuration(node.durationMs)}` : ''}
                      </span>
                    </span>
                  </button>
                  {open ? (
                    <div className="border-t border-[#eeedf1] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[#5d5e66]">
                      <DetailLine label="Type" value={getNodeType(node.nodeType).label} />
                      <DetailLine
                        label="Started"
                        value={node.startedAt ? formatTimestamp(node.startedAt) : '—'}
                      />
                      <DetailLine
                        label="Finished"
                        value={node.finishedAt ? formatTimestamp(node.finishedAt) : '—'}
                      />
                      <DetailLine
                        label="Duration"
                        value={node.durationMs !== null ? formatDuration(node.durationMs) : '—'}
                      />
                      {node.outputSummary !== null && node.outputSummary.length > 0 ? (
                        <DetailLine label="Output" value={truncate(node.outputSummary, 280)} />
                      ) : null}
                      {node.meta ? <NodeMetaBlock meta={node.meta} /> : null}
                      {node.error ? (
                        <p className="mt-1.5 rounded-md border border-[#e9d5d8] bg-[#fbf0f1] px-2 py-1.5 text-[11.5px] text-[#c22f3d]">
                          {truncate(node.error, 280)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>

        {run.nodes.length === 0 ? (
          <EmptyState
            icon={<ZapIcon size={18} strokeWidth={1.8} />}
            title="No step records"
            description="This run has no recorded node executions."
            compact
          />
        ) : null}
      </div>
    </Page>
  )
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex gap-2">
      <span className="min-w-[64px] font-medium text-[#8b8c95]">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </p>
  )
}

/* ------------------------------------------------------------------ */
/* Browser operation results                                           */
/* ------------------------------------------------------------------ */

/**
 * Node metadata recorded by the engine. Two shapes exist:
 * browser operations (real session data) and Paper Instruments
 * generations (real usage numbers from the API response).
 */
function NodeMetaBlock({ meta }: { meta: NonNullable<RunRecord['nodes'][number]['meta']> }) {
  if ('operation' in meta) return <BrowserMetaBlock meta={meta} />
  return <GenerationMetaBlock meta={meta} />
}

/**
 * Real, bounded browser metadata recorded by the engine. A screenshot
 * is only offered when its artifact actually exists; the image is
 * loaded through the single validated artifact IPC, not a file path.
 */
function BrowserMetaBlock({ meta }: { meta: Extract<NonNullable<RunRecord['nodes'][number]['meta']>, { operation: string }> }) {
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <DetailLine label="Operation" value={meta.operation} />
      {meta.finalUrl ? <DetailLine label="Final URL" value={truncate(meta.finalUrl, 220)} /> : null}
      {meta.pageTitle ? <DetailLine label="Page title" value={truncate(meta.pageTitle, 220)} /> : null}
      {meta.textChars !== null ? (
        <DetailLine
          label="Extracted"
          value={`${meta.textChars} characters${meta.textTruncated ? ' (truncated to the step limit)' : ''}`}
        />
      ) : null}
      {typeof meta.durationMs === 'number' ? (
        <DetailLine label="Browser time" value={formatDuration(meta.durationMs)} />
      ) : null}
      {meta.sessionId ? <DetailLine label="Session" value={meta.sessionId} /> : null}
      {meta.screenshotId && ARTIFACT_ID_RE.test(meta.screenshotId) ? (
        <ScreenshotArtifact artifactId={meta.screenshotId} />
      ) : null}
    </div>
  )
}

/**
 * Real, bounded Paper Instruments generation metadata. Token counts are
 * the provider's reported usage values verbatim — never estimated
 * locally — and balance figures only appear when the API actually
 * returned them before the call.
 */
function GenerationMetaBlock({
  meta
}: {
  meta: Extract<NonNullable<RunRecord['nodes'][number]['meta']>, { model: string }>
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <DetailLine label="Model" value={meta.model} />
      {meta.finishReason ? <DetailLine label="Finish" value={meta.finishReason} /> : null}
      {meta.finishReason === 'length' || meta.truncated ? (
        <DetailLine label="Note" value="Output was truncated at the token limit." />
      ) : null}
      {meta.structuredOutput ? <DetailLine label="Validation" value="Structured output (JSON schema subset) checked." /> : null}
      {meta.promptTokens !== null || meta.completionTokens !== null ? (
        <DetailLine
          label="Tokens"
          value={`${meta.promptTokens ?? 0} prompt · ${meta.completionTokens ?? 0} completion${
            meta.reasoningTokens !== null ? ` · ${meta.reasoningTokens} reasoning` : ''
          } · ${meta.totalTokens ?? 0} total`}
        />
      ) : null}
      {meta.balanceAvailableUsd !== null ? (
        <DetailLine
          label="Balance"
          value={`$${meta.balanceAvailableUsd.toFixed(2)} available before the call`}
        />
      ) : null}
      {typeof meta.durationMs === 'number' ? (
        <DetailLine label="Duration" value={formatDuration(meta.durationMs)} />
      ) : null}
    </div>
  )
}

function ScreenshotArtifact({ artifactId }: { artifactId: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let disposed = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const payload = await getApi().getArtifact(artifactId)
        if (disposed) return
        if (!payload || payload.mimeType !== 'image/png') {
          setMissing(true)
          return
        }
        const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0))
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        setSrc(objectUrl)
      } catch {
        if (!disposed) setMissing(true)
      }
    })()
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [artifactId])

  const expanded = src !== null
  return (
    <div className="mt-1">
      <p className="flex items-center gap-1.5 text-[11.5px] text-[#8b8c95]">
        <ImageIcon size={13} strokeWidth={1.8} className="shrink-0" />
        {missing ? 'The screenshot artifact is no longer available.' : 'Screenshot captured from the session.'}
      </p>
      {expanded ? (
        <img
          src={src}
          alt={`Screenshot artifact ${artifactId}`}
          className="mt-1.5 max-h-[320px] w-auto max-w-full rounded-lg border border-[#e6e6ea]"
        />
      ) : null}
    </div>
  )
}

const DOT_ICONS: Record<NodeRunStatus, { Icon: typeof CircleIcon | null; className: string }> = {
  pending: { Icon: CircleIcon, className: 'text-[#c9cad1]' },
  running: { Icon: LoaderCircleIcon, className: 'animate-spin text-[#3f4cc0] motion-reduce:animate-none' },
  succeeded: { Icon: CircleCheckIcon, className: 'text-[#157f3d]' },
  skipped: { Icon: CircleSlashIcon, className: 'text-[#a2a3ac]' },
  failed: { Icon: CircleXIcon, className: 'text-[#c22f3d]' },
  cancelled: { Icon: CircleMinusIcon, className: 'text-[#a05a12]' }
}

function NodeStateDot({ status }: { status: NodeRunStatus }) {
  const { Icon, className } = DOT_ICONS[status]
  return Icon ? (
    <Icon size={15} strokeWidth={2.1} className={cn('shrink-0', className)} />
  ) : (
    <span className="h-[15px] w-[15px] shrink-0 rounded-full border border-[#c9cad1]" />
  )
}

/* ------------------------------------------------------------------ */

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** Human-friendly relative time; the exact timestamp stays in the title. */
function formatRelative(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return formatTimestamp(iso)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) * 100)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m ${seconds}s`
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
