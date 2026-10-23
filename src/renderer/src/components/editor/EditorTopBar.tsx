import {
  Play as PlayIcon,
  Plus as PlusIcon,
  Save as SaveIcon,
  Check as CheckIcon,
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  Square as SquareIcon
} from 'lucide-react'
import type { RunStatus } from '../../../../shared/runTypes'
import { Button, IconButton } from '../ui/Button'
import { FlowloomBrand } from '../shell/FlowloomMark'
import { cn } from '../../lib/cn'

/**
 * Editor toolbar: workflow name, add-node, undo/redo, a real Run action
 * (saves the dirty graph first, then starts a main-process run), a live
 * run status chip with Cancel, and Save. Every control is real; nothing
 * decorative.
 */
export function EditorTopBar({
  name,
  hasWorkflow,
  dirty,
  saving,
  savedFlash,
  libraryOpen,
  canUndo,
  canRedo,
  incompleteCount,
  runStatus,
  starting,
  onNameChange,
  onNameCommit,
  onNameReset,
  onToggleLibrary,
  onUndo,
  onRedo,
  onStartRun,
  onCancelRun,
  onSave
}: {
  name: string
  hasWorkflow: boolean
  dirty: boolean
  saving: boolean
  savedFlash: boolean
  libraryOpen: boolean
  canUndo: boolean
  canRedo: boolean
  incompleteCount: number
  /** Live/terminal status of this workflow's latest run, if any. */
  runStatus: RunStatus | null
  starting: boolean
  onNameChange: (value: string) => void
  onNameCommit: () => void
  onNameReset: () => void
  onToggleLibrary: () => void
  onUndo: () => void
  onRedo: () => void
  onStartRun: () => void
  onCancelRun: () => void
  onSave: () => void
}) {
  const runActive = runStatus !== null && (runStatus === 'queued' || runStatus === 'validating' || runStatus === 'running' || runStatus === 'cancelling')
  const runLabel =
    runStatus === 'cancelled' ? 'Cancelled' : runStatus === 'failed' ? 'Failed' : runStatus === 'cancelling' ? 'Cancelling…' : runStatus === 'succeeded' ? 'Succeeded' : runStatus === 'validating' || runStatus === 'queued' ? 'Starting…' : runStatus === 'running' ? 'Running' : null
  return (
    <div className="flex min-h-[49px] shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-[#e6e6ea] bg-white px-3 py-1.5">
      {hasWorkflow ? (
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={() => {
            if (name.trim() === '') onNameReset()
            else if (dirty) onNameCommit()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') onNameReset()
          }}
          title="Workflow name"
          aria-label="Workflow name"
          placeholder="Untitled workflow"
          className="mr-1 w-[240px] min-w-[120px] max-w-[45vw] rounded-md bg-transparent px-1.5 py-1 text-[13.5px] font-semibold tracking-tight text-[#1c1d21] outline-none placeholder:text-[#a2a3ac] hover:bg-[#f6f6f8] focus:bg-[#f6f6f8]"
        />
      ) : (
        <span className="px-2 text-[13.5px] font-semibold tracking-tight text-[#6f707a]">
          No workflow open
        </span>
      )}

      <span className="flex-1" />

      {hasWorkflow ? (
        <>
          {incompleteCount > 0 ? (
            <span
              className="mr-1 hidden items-center gap-1.5 rounded-full border border-[#f0e5cf] bg-[#fbf6ec] px-2 py-0.5 text-[10.5px] font-medium text-[#a05a12] md:flex"
              title="Steps with missing details — finish them in the inspector"
            >
              {incompleteCount} step{incompleteCount === 1 ? '' : 's'} need setup
            </span>
          ) : null}
          <span
            aria-hidden
            title={dirty ? 'Unsaved changes' : 'All changes saved'}
            className={cn(
              'mr-1 h-[7px] w-[7px] rounded-full',
              dirty ? 'bg-[#a05a12]' : 'bg-[#8fdc9b]'
            )}
          />
          <IconButton label="Undo the last editor action" disabled={!canUndo} onClick={onUndo}>
            <UndoIcon size={15} strokeWidth={2} />
          </IconButton>
          <IconButton label="Redo" disabled={!canRedo} onClick={onRedo}>
            <RedoIcon size={15} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Node library"
            active={libraryOpen}
            onClick={onToggleLibrary}
          >
            <PlusIcon size={16} strokeWidth={2.2} />
          </IconButton>
          {runActive ? (
            <>
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  runStatus === 'cancelling'
                    ? 'border-[#ecdcc4] bg-[#fbf6ec] text-[#7a5a24]'
                    : 'border-[#dde0f4] bg-[#eef0fb] text-[#3f4cc0]'
                )}
                role="status"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-[7px] w-[7px] rounded-full',
                    runStatus === 'cancelling' ? 'bg-[#ecdcc4]' : 'animate-pulse bg-[#3f4cc0]'
                  )}
                />
                {runLabel ?? 'Running'}
              </span>
              <Button
                size="md"
                variant="secondary"
                onClick={onCancelRun}
                title="Cancel the running workflow"
                className="ml-1"
              >
                <SquareIcon size={12.5} strokeWidth={2.2} />
                Cancel run
              </Button>
            </>
          ) : (
            <Button
              size="md"
              variant={runLabel ? 'secondary' : 'primary'}
              busy={starting}
              disabled={!hasWorkflow || starting}
              onClick={onStartRun}
              title={
                incompleteCount > 0
                  ? 'Run — steps that still need setup will be reported before anything executes'
                  : 'Save and run this workflow'
              }
              className="ml-1"
            >
              <PlayIcon size={13} strokeWidth={2} />
              Run
            </Button>
          )}
          {runLabel && !runActive ? (
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                runStatus === 'failed'
                  ? 'border-[#e9d5d8] bg-[#fbf0f1] text-[#c22f3d]'
                  : runStatus === 'cancelled'
                    ? 'border-[#ecdcc4] bg-[#fbf6ec] text-[#7a5a24]'
                    : 'border-[#d5e8d9] bg-[#f0f8f2] text-[#157f3d]'
              )}
              role="status"
            >
              {runLabel}
            </span>
          ) : null}
          <Button
            size="md"
            variant="primary"
            busy={saving}
            disabled={!dirty || saving}
            onClick={onSave}
            title={dirty ? 'Save changes' : 'No changes to save'}
            className="ml-1"
          >
            {savedFlash && !dirty ? (
              <>
                <CheckIcon size={14} strokeWidth={2.2} />
                Saved
              </>
            ) : (
              <>
                <SaveIcon size={14} strokeWidth={2} />
                Save
              </>
            )}
          </Button>
        </>
      ) : null}
      <span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-[#e6e6ea] sm:block" />
      <FlowloomBrand />
    </div>
  )
}
