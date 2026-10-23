import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import {
  TriangleAlert as AlertIcon,
  Circle as CircleIcon,
  CircleOff as CircleOffIcon,
  CircleCheck as CircleCheckIcon,
  CircleMinus as CircleMinusIcon,
  CircleX as CircleXIcon,
  CircleSlash as CircleSlashIcon,
  LoaderCircle as LoaderCircleIcon
} from 'lucide-react'
import type { NodeTypeId } from '../../../../shared/nodeSchema'
import { getNodeType } from '../../../../shared/nodeSchema'
import type { NodeRunStatus } from '../../../../shared/runTypes'
import { cn } from '../../lib/cn'
import { nodeDisplay } from './nodeDisplay'

/**
 * Flow editor node cards. Compact rectangular cards with a tinted icon
 * chip, a title, a one-line configuration summary, and circular
 * connection handles — matching the reference's node language. Long
 * forms live in the inspector, never inside the card.
 *
 * During a run, cards additionally wear the live execution state as a
 * restrained border treatment plus a small trailing dot: running is
 * indigo, success green, failure red, skips grey-dashed, cancelled
 * amber. The canvas is never flooded with color.
 */

export interface FlowNodeData extends Record<string, unknown> {
  typeId: NodeTypeId
  config: Record<string, unknown>
  /** Live execution state pushed from the main-process engine. */
  runStatus?: NodeRunStatus
  /** Latest real engine stage message (redacted, capped), if any. */
  stage?: string
}

export type FlowNode = Node<FlowNodeData>

const HANDLE_CLASS = cn(
  '!h-3 !w-3 !rounded-full !border-2 !bg-white !shadow-none',
  '!border-[#c9cad1]',
  'transition-[border-color,background-color] duration-100 hover:!border-[#5c66e0]',
  '!outline-none focus-visible:!border-[#3f4cc0]'
)

function OutputHandle({ id, top }: { id: string; top: string }) {
  return (
    <Handle
      type="source"
      id={id}
      position={Position.Right}
      style={{ top }}
      className={HANDLE_CLASS}
      aria-label={`Connect from ${id}`}
    />
  )
}

function InputHandle() {
  return (
    <Handle
      type="target"
      id="in"
      position={Position.Left}
      className={HANDLE_CLASS}
      aria-label="Connect to this step"
    />
  )
}

const RUN_STATUS_STYLES: Record<
  NodeRunStatus,
  { card: string; dot: string; icon: typeof CircleIcon | null; pulse: boolean }
> = {
  pending: { card: 'border-[#e3e4e8]', dot: 'border border-[#c9cad1] bg-white', icon: null, pulse: false },
  running: {
    card: 'border-[#3f4cc0] ring-[3px] ring-[#3f4cc0]/15',
    dot: 'border border-[#3f4cc0] bg-[#eef0fb]',
    icon: LoaderCircleIcon,
    pulse: true
  },
  succeeded: {
    card: 'border-[#b7dcc2]',
    dot: 'border border-[#8fdc9b] bg-[#eef7f1]',
    icon: CircleCheckIcon,
    pulse: false
  },
  skipped: {
    card: 'border-dashed border-[#d5d5da] opacity-[0.72]',
    dot: 'border border-dashed border-[#c9cad1] bg-[#f6f6f8]',
    icon: CircleSlashIcon,
    pulse: false
  },
  failed: {
    card: 'border-[#e0a9af] ring-[3px] ring-[#c22f3d]/10',
    dot: 'border border-[#e0a9af] bg-[#fbeef0]',
    icon: CircleXIcon,
    pulse: false
  },
  cancelled: {
    card: 'border-[#ecd7bb]',
    dot: 'border border-[#ecdcc4] bg-[#fbf6ec]',
    icon: CircleMinusIcon,
    pulse: false
  }
}

function RunStatusDot({ status }: { status: NodeRunStatus }) {
  const style = RUN_STATUS_STYLES[status]
  return (
    <span
      aria-hidden
      title={`Run state: ${status}`}
      className={cn(
        'absolute right-[9px] top-[9px] flex h-[13px] w-[13px] items-center justify-center rounded-full',
        style.dot
      )}
    >
      {style.icon ? (
        <style.icon
          size={9}
          strokeWidth={2.4}
          className={cn('text-[#3f4cc0]', style.pulse && 'animate-spin motion-reduce:animate-none')}
        />
      ) : null}
    </span>
  )
}

function NodeCard({
  typeId,
  title,
  summary,
  selected,
  incomplete,
  runStatus,
  stage
}: {
  typeId: NodeTypeId
  title: string
  summary: string
  selected: boolean
  incomplete: boolean
  runStatus?: NodeRunStatus
  stage?: string
}) {
  const meta = nodeDisplay[typeId]
  const Icon = meta.icon
  const running = runStatus === 'running'
  // While a step runs, the card below the summary shows the latest REAL
  // engine stage (never a simulated percentage).
  // Browser steps are configured and saved in this phase but cannot
  // execute until the browser-automation phase — say so on the card
  // instead of letting a run refusal be the first notice.
  const notExecutable = !getNodeType(typeId).executable
  return (
    <div
      className={cn(
        'w-[208px] rounded-[12px] border bg-white transition-shadow duration-100',
        'shadow-[0_1px_2px_rgba(20,20,24,0.05)]',
        runStatus
          ? RUN_STATUS_STYLES[runStatus].card
          : selected
            ? 'border-[#3f4cc0] ring-[3px] ring-[#3f4cc0]/15'
            : 'border-[#e3e4e8] hover:border-[#cbccd3]'
      )}
    >
      {incomplete ? (
        <div
          className="flex items-center gap-1.5 rounded-t-[10px] border-b border-[#f0e5cf] bg-[#fbf6ec] px-2.5 py-1 text-[10.5px] font-medium text-[#a05a12]"
          role="status"
        >
          <AlertIcon size={10.5} strokeWidth={2.2} className="shrink-0" />
          Setup needed
        </div>
      ) : null}
      {!incomplete && notExecutable ? (
        <div
          className="flex items-center gap-1.5 rounded-t-[10px] border-b border-[#dde0f4] bg-[#eef0fb] px-2.5 py-1 text-[10.5px] font-medium text-[#3f4cc0]"
          role="status"
          title="Browser steps become executable in a later Flowloom phase — runs refuse them until then"
        >
          <CircleOffIcon size={10.5} strokeWidth={2.2} className="shrink-0" />
          Can't run yet
        </div>
      ) : null}
      <div className="flex items-center gap-2.5 px-2.5 py-2.5">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
            meta.tint.bg,
            meta.tint.border,
            meta.tint.text
          )}
        >
          <Icon size={14} strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1 pr-4">
          <span className="block truncate text-[12.5px] font-semibold leading-tight tracking-tight text-[#1c1d21]">
            {title}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-[#8b8c95]">
            {stage && running ? stage : summary}
          </span>
        </span>
      </div>
      {runStatus ? <RunStatusDot status={runStatus} /> : null}
    </div>
  )
}

/** Shared body: derives everything from the registry so cards never drift. */
function useNodeView(typeId: NodeTypeId, config: Record<string, unknown>) {
  const definition = getNodeType(typeId)
  const missing = definition.requiredFields(config)
  const title =
    (typeId === 'browserAction' || typeId === 'paperInstruments') &&
    typeof config['name'] === 'string' &&
    config['name']
      ? config['name']
      : definition.defaultTitle
  return {
    title,
    missing,
    summary: missing.length > 0 ? definition.description : definition.summarize(config)
  }
}

function StandardBody({
  typeId,
  config,
  selected,
  runStatus,
  stage
}: {
  typeId: NodeTypeId
  config: Record<string, unknown>
  selected: boolean
  runStatus?: NodeRunStatus
  stage?: string
}) {
  const view = useNodeView(typeId, config)
  return (
    <NodeCard
      typeId={typeId}
      title={view.title}
      summary={view.summary}
      selected={selected}
      incomplete={view.missing.length > 0}
      runStatus={runStatus}
      stage={stage}
    />
  )
}

export const TriggerNode = memo(function TriggerNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <OutputHandle id="out" top="50%" />
      <StandardBody typeId="trigger" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

export const BrowserActionNode = memo(function BrowserActionNode({
  data,
  selected
}: NodeProps<FlowNode>) {
  return (
    <>
      <InputHandle />
      <OutputHandle id="out" top="50%" />
      <StandardBody typeId="browserAction" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

export const DelayNode = memo(function DelayNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <InputHandle />
      <OutputHandle id="out" top="50%" />
      <StandardBody typeId="delay" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

/** Two visible branch outputs — the registry drives the semantics. */
export const ConditionNode = memo(function ConditionNode({
  data,
  selected
}: NodeProps<FlowNode>) {
  return (
    <>
      <InputHandle />
      <OutputHandle id="true" top="30%" />
      <OutputHandle id="false" top="70%" />
      <span
        aria-hidden
        className="pointer-events-none absolute text-[10px] font-medium text-[#a2a3ac]"
        style={{ top: '30%', left: 'calc(100% + 6px)', transform: 'translateY(-50%)' }}
      >
        Matches
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute text-[10px] font-medium text-[#a2a3ac]"
        style={{ top: '70%', left: 'calc(100% + 6px)', transform: 'translateY(-50%)' }}
      >
        Otherwise
      </span>
      <StandardBody typeId="condition" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

export const DataNode = memo(function DataNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <InputHandle />
      <OutputHandle id="out" top="50%" />
      <StandardBody typeId="data" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

export const PaperInstrumentsNode = memo(function PaperInstrumentsNode({
  data,
  selected
}: NodeProps<FlowNode>) {
  return (
    <>
      <InputHandle />
      <OutputHandle id="out" top="50%" />
      <StandardBody typeId="paperInstruments" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

export const JoinNode = memo(function JoinNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <InputHandle />
      <OutputHandle id="out" top="50%" />
      <StandardBody typeId="join" config={data.config} selected={selected} runStatus={data.runStatus} stage={data.stage} />
    </>
  )
})

export const flowNodeTypes = {
  trigger: TriggerNode,
  browserAction: BrowserActionNode,
  delay: DelayNode,
  condition: ConditionNode,
  data: DataNode,
  join: JoinNode,
  paperInstruments: PaperInstrumentsNode
}
