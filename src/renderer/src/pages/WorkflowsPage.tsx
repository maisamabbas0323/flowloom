import { useCallback, useEffect, useState } from 'react'
import {
  Plus as PlusIcon,
  FolderOpen as FolderIcon,
  Trash2 as TrashIcon,
  ArrowRight as ArrowIcon,
  Copy as CopyIcon
} from 'lucide-react'
import { Button, IconButton } from '../components/ui/Button'
import { EmptyState } from '../components/ui/Micro'
import { FlowloomBrand } from '../components/shell/FlowloomMark'
import { getApi } from '../lib/api'
import { formatDateTime } from '../lib/format'
import type { WorkflowSummary } from '../../../shared/contracts'

export function WorkflowsPage({
  version,
  onOpen,
  onNewWorkflow,
  onDeleted
}: {
  version: number
  onOpen: (id: string) => void
  onNewWorkflow: () => void
  /** Fires after a workflow is deleted so the app can drop it from the editor too. */
  onDeleted?: (id: string) => void
}) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setWorkflows(await getApi().listWorkflows())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load workflows.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, version])

  const remove = async (id: string) => {
    const deleted = await getApi().deleteWorkflow(id)
    setConfirmingId(null)
    if (deleted) onDeleted?.(id)
    void load()
  }

  const duplicate = async (id: string) => {
    await getApi().duplicateWorkflow(id)
    void load()
  }

  return (
    <Page title="Workflows" subtitle="Workflow records saved on this machine." actions={
      <Button variant="primary" onClick={onNewWorkflow}>
        <PlusIcon size={14} strokeWidth={2.2} />
        New workflow
      </Button>
    }>
      {error ? <p className="text-[12.5px] text-[#c22f3d]">{error}</p> : null}
      {workflows === null ? null : workflows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<FolderIcon size={20} strokeWidth={1.8} />}
            title="No workflows yet"
            description="Create a workflow record now. Building its steps on the canvas arrives with the visual editor phase."
            actions={
              <Button variant="primary" onClick={onNewWorkflow}>
                <PlusIcon size={14} strokeWidth={2.2} />
                New workflow
              </Button>
            }
            compact
          />
        </div>
      ) : (
        <div className="mt-1 overflow-hidden rounded-xl border border-[#e6e6ea] bg-white shadow-[0_1px_2px_rgba(20,20,24,0.04)]">
          <ul className="divide-y divide-[#f0f0f3]">
            {workflows.map((wf) => (
              <li
                key={wf.id}
                className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-[#fafafa]"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#e9e9ee] bg-[#fafafa] text-[#6f707a]">
                  <FolderIcon size={16} strokeWidth={1.8} />
                </div>
                <div className="min-w-[140px] flex-1">
                  <p className="truncate text-[13px] font-medium text-[#1c1d21]">{wf.name}</p>
                  <p className="truncate text-[11.5px] text-[#a2a3ac]">
                    Created {formatDateTime(wf.createdAt)} · Updated {formatDateTime(wf.updatedAt)}
                  </p>
                </div>
                {confirmingId === wf.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11.5px] text-[#6f707a]">Delete for good?</span>
                    <Button variant="danger-ghost" size="sm" onClick={() => void remove(wf.id)}>
                      Delete
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmingId(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1">
                    <IconButton
                      label="Duplicate workflow"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => void duplicate(wf.id)}
                    >
                      <CopyIcon size={14} strokeWidth={2} />
                    </IconButton>
                    <IconButton
                      label="Delete workflow"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => setConfirmingId(wf.id)}
                    >
                      <TrashIcon size={14} strokeWidth={2} />
                    </IconButton>
                    <Button variant="secondary" size="sm" onClick={() => onOpen(wf.id)}>
                      Open
                      <ArrowIcon size={12} strokeWidth={2} />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Page>
  )
}

/** Shared page frame: title bar + padded content column. */
export function Page({
  title,
  subtitle,
  actions,
  children
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex min-h-[49px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#e6e6ea] bg-white px-4 py-1.5 sm:px-5">
        <h1 className="shrink-0 text-[14px] font-semibold tracking-tight text-[#1c1d21]">{title}</h1>
        {subtitle ? (
          <p className="min-w-0 max-w-[46ch] truncate text-[12px] text-[#a2a3ac]">{subtitle}</p>
        ) : null}
        <span className="flex-1" />
        {actions}
        <span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-[#e6e6ea] sm:block" />
        <FlowloomBrand />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 sm:px-5">{children}</div>
    </div>
  )
}
