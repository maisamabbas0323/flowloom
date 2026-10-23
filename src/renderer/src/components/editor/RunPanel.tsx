import { useEffect, useState } from 'react'
import {
  History as HistoryIcon,
  Square as SquareIcon,
  CircleCheck as CircleCheckIcon,
  CircleX as CircleXIcon,
  CircleSlash as CircleSlashIcon,
  CircleMinus as CircleMinusIcon,
  LoaderCircle as LoaderCircleIcon,
  Circle as CircleIcon,
  Volume2 as VolumeIcon,
  VolumeX as VolumeOffIcon
} from 'lucide-react'
import type { NodeRunStatus, RunStatus } from '../../../../shared/runTypes'
import { isTerminalRunStatus } from '../../../../shared/runTypes'
import type { NodeTypeId } from '../../../../shared/nodeSchema'
import { getNodeType } from '../../../../shared/nodeSchema'
import type { FlowNode } from './nodeTypes'
import { getApi } from '../../lib/api'
import { raiseNarrationMute } from '../shell/NarrationPlayer'
import { cn } from '../../lib/cn'

/**
 * The run-inspection panel: a compact overlay while a run of the open
 * workflow is live, and a truthful summary once it finishes. No fake
 * progress percentages — the node timeline *is* the progress, driven by
 * real engine events.
 */

interface RunPanelState {
  runId: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  error: string | null
  nodes: Array<{ id: string; title: string; type: NodeTypeId; status: NodeRunStatus; stage?: string }>
}

export function RunPanel({
  run,
  onCancel,
  onOpenHistory,
  onFocusNode
}: {
  run: RunPanelState | null
  onCancel: () => void
  onOpenHistory: () => void
  onFocusNode: (nodeId: string) => void
}) {
  const [tick, setTick] = useState(0)
  const active = run !== null && !isTerminalRunStatus(run.status)
  const [narrationOn, setNarrationOn] = useState(false)
  const [muteBusy, setMuteBusy] = useState(false)

  // The mute control reflects the real narration preference while a run
  // is live. Muting stops current playback immediately and makes the
  // main process skip every later announcement.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void getApi()
      .getConfig()
      .then((config) => {
        if (!cancelled && config) setNarrationOn(config.voice.narration.enabled)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active])

  const toggleNarration = async (): Promise<void> => {
    setMuteBusy(true)
    try {
      const next = !narrationOn
      const result = await getApi().saveVoiceSettings({ narrationEnabled: next })
      if (result.ok) {
        setNarrationOn(next)
        if (!next) raiseNarrationMute()
      }
    } finally {
      setMuteBusy(false)
    }
  }

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 500)
    return () => window.clearInterval(timer)
  }, [active])
  void tick

  if (!run) return null

  const startedMs = Date.parse(run.startedAt)
  const finishedMs = run.finishedAt ? Date.parse(run.finishedAt) : null
  const elapsedMs = finishedMs !== null ? finishedMs - startedMs : Date.now() - startedMs
  const succeededNodes = run.nodes.filter((node) => node.status === 'succeeded').length
  const waitingNodes = run.nodes.filter((node) => node.status === 'running').length

  return (
    <div
      role="region"
      aria-label="Run inspector"
      className="absolute bottom-16 right-4 z-20 flex max-h-[440px] w-[288px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-[#e3e4e8] bg-white shadow-[0_8px_32px_rgba(20,20,24,0.14)]"
    >
      <div className="shrink-0 border-b border-[#eeedf1] px-3.5 pb-2.5 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[12.5px] font-semibold tracking-tight text-[#1c1d21]">
            {run.status === 'running' || run.status === 'cancelling' ? 'Running' : run.status === 'succeeded' ? 'Run finished' : run.status === 'failed' ? 'Run failed' : run.status === 'cancelled' ? 'Run cancelled' : 'Starting run'}
          </span>
          <RunStateChip status={run.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-[#8b8c95]">
          <span className="num">{formatDuration(elapsedMs)}</span>
          <span aria-hidden>·</span>
          <span>
            {run.status === 'running' && waitingNodes > 0
              ? `${succeededNodes} done · ${waitingNodes} active · ${run.nodes.length} total`
              : `${succeededNodes} of ${run.nodes.length} step${run.nodes.length === 1 ? '' : 's'} ran`}
          </span>
          {active ? (
            <button
              type="button"
              aria-pressed={narrationOn}
              aria-label={narrationOn ? 'Mute voice feedback' : 'Unmute voice feedback'}
              title={narrationOn ? 'Mute voice feedback' : 'Unmute voice feedback'}
              disabled={muteBusy}
              onClick={() => void toggleNarration()}
              className={cn(
                'ml-auto rounded-md p-1 transition-colors hover:bg-[#f2f2f5]',
                narrationOn ? 'text-[#3f4cc0]' : 'text-[#a2a3ac]'
              )}
            >
              {narrationOn ? <VolumeIcon size={13} strokeWidth={2} /> : <VolumeOffIcon size={13} strokeWidth={2} />}
            </button>
          ) : null}
        </div>
        {run.error ? (
          <p className="mt-1.5 rounded-md border border-[#e9d5d8] bg-[#fbf0f1] px-2 py-1.5 text-[11px] leading-relaxed text-[#c22f3d]">
            {run.error}
          </p>
        ) : null}
      </div>

      <ul className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
        {run.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => onFocusNode(node.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[#f6f6f8]"
            >
              <NodeStateDot status={node.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium leading-tight text-[#1c1d21]">
                  {node.title}
                </span>
                <span className="block truncate text-[10.5px] leading-tight text-[#a2a3ac]">
                  {node.stage && node.status === 'running' ? node.stage : getNodeType(node.type).label}
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 text-[10.5px] font-medium capitalize',
                  node.status === 'failed'
                    ? 'text-[#c22f3d]'
                    : node.status === 'running'
                      ? 'text-[#3f4cc0]'
                      : node.status === 'succeeded'
                        ? 'text-[#157f3d]'
                        : 'text-[#a2a3ac]'
                )}
              >
                {node.status}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-[#eeedf1] px-2.5 py-2">
        {active ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-[#c22f3d] transition-colors hover:bg-[#fbf0f1]"
          >
            <SquareIcon size={11.5} strokeWidth={2.2} />
            Cancel run
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onOpenHistory}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-[#5d5e66] transition-colors hover:bg-[#f6f6f8]"
        >
          <HistoryIcon size={11.5} strokeWidth={2.2} />
          All runs
        </button>
      </div>
    </div>
  )
}

function RunStateChip({ status }: { status: RunStatus }) {
  const active = status === 'queued' || status === 'validating' || status === 'running'
  const cancelling = status === 'cancelling'
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium capitalize',
        active
          ? 'border-[#dde0f4] bg-[#eef0fb] text-[#3f4cc0]'
          : cancelling
            ? 'border-[#ecdcc4] bg-[#fbf6ec] text-[#7a5a24]'
            : status === 'succeeded'
              ? 'border-[#d5e8d9] bg-[#f0f8f2] text-[#157f3d]'
              : status === 'failed'
                ? 'border-[#e9d5d8] bg-[#fbf0f1] text-[#c22f3d]'
                : 'border-[#ecdcc4] bg-[#fbf6ec] text-[#7a5a24]'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-[6px] w-[6px] rounded-full',
          active ? 'animate-pulse bg-[#3f4cc0]' : cancelling ? 'bg-[#ecdcc4]' : status === 'succeeded' ? 'bg-[#8fdc9b]' : status === 'failed' ? 'bg-[#e0a9af]' : 'bg-[#ecdcc4]'
        )}
      />
      {status}
    </span>
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
  return Icon ? <Icon size={13} strokeWidth={2.1} className={cn('shrink-0', className)} /> : <span className="h-[13px] w-[13px] shrink-0 rounded-full border border-[#c9cad1]" />
}

/** Builds the panel state for the open workflow's nodes. */
export function deriveRunNodes(
  nodeIdStatuses: Map<string, NodeRunStatus>,
  canvasNodes: FlowNode[]
): RunPanelState['nodes'] {
  return canvasNodes.map((node) => ({
    id: node.id,
    title: nodeCardTitle(node.data.typeId, node.data.config),
    type: node.data.typeId,
    status: nodeIdStatuses.get(node.id) ?? ('pending' as NodeRunStatus),
    stage: node.data.stage
  }))
}

function nodeCardTitle(typeId: NodeTypeId, config: Record<string, unknown>): string {
  const definition = getNodeType(typeId)
  if (typeId === 'browserAction' && typeof config['name'] === 'string' && config['name']) {
    return config['name']
  }
  return definition.defaultTitle
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m elapsed`
  }
  if (minutes > 0) return `${minutes}m ${seconds}s elapsed`
  return `${seconds}s elapsed`
}
