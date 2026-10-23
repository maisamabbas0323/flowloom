import { CircleCheck as CircleCheckIcon } from 'lucide-react'
import { StatusDotTest } from '../../components/ui/Micro'
import { cn } from '../../lib/cn'
import { formatDateTime, formatDuration } from '../../lib/format'
import type { PlainFieldView, TestRecord } from '../../../../shared/contracts'

/** Displays an effective plain value and where it currently comes from. */
export function EffectiveLine({
  entity,
  value,
  source,
  extra
}: {
  entity: string
  value: string
  source: PlainFieldView['source']
  extra?: { label: string; value: string; mono?: boolean }
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[#8b8c95]">
      <span>
        {entity}: <span className="font-medium text-[#1c1d21]">{value}</span>
      </span>
      <SourceCorner source={source} />
      {extra ? (
        <>
          <span className="text-[#c9cad1]">·</span>
          <span>
            {extra.label}:{' '}
            <span className={cn('font-medium text-[#1c1d21]', extra.mono && 'font-mono text-[11px]')}>{extra.value}</span>
          </span>
        </>
      ) : null}
    </div>
  )
}

function SourceCorner({ source }: { source: PlainFieldView['source'] }) {
  if (source === 'env') {
    return <span className="rounded-full bg-[#f4f4f5] px-1.5 py-px text-[10.5px] font-medium text-[#6f707a]">from .env</span>
  }
  if (source === 'default') {
    return <span className="rounded-full bg-[#f4f4f5] px-1.5 py-px text-[10.5px] font-medium text-[#6f707a]">default</span>
  }
  if (source === 'unset') {
    return <span className="italic text-[#a2a3ac]">not set</span>
  }
  return <span className="rounded-full bg-[#eef0fb] px-1.5 py-px text-[10.5px] font-medium text-[#3f4cc0]">saved</span>
}

export type ChipStatus = 'unconfigured' | 'untested' | 'testing' | 'connected' | 'failed'

/** Section-level status chip covering the honest states. */
export function StatusChip({
  status,
  missing,
  label
}: {
  status: ChipStatus
  missing?: string[]
  label?: string
}) {
  const meta = {
    unconfigured: {
      text: 'text-[#6f707a]',
      bg: 'bg-[#f4f4f5]',
      icon: 'bg-[#b4b5bd]',
      message: label ?? `Not configured${missing?.length ? ` — missing: ${missing.join(', ')}` : ''}`
    },
    untested: {
      text: 'text-[#6f707a]',
      bg: 'bg-[#f4f4f5]',
      icon: 'bg-[#b4b5bd]',
      message: label ?? 'Configured — not tested yet'
    },
    testing: {
      text: 'text-[#a05a12]',
      bg: 'bg-[#fbf2e5]',
      icon: 'bg-[#d99a44]',
      message: label ?? 'Testing…'
    },
    connected: {
      text: 'text-[#157f3d]',
      bg: 'bg-[#e8f6ec]',
      icon: 'bg-[#157f3d]',
      message: label ?? 'Connection verified'
    },
    failed: {
      text: 'text-[#c22f3d]',
      bg: 'bg-[#fbeaec]',
      icon: 'bg-[#c22f3d]',
      message: label ?? 'Failed'
    }
  }[status]
  return (
    <span className={cn('inline-flex h-6 self-start items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium', meta.text, meta.bg)}>
      <StatusDotTest color={meta.icon} spinning={status === 'testing'} />
      {meta.message}
    </span>
  )
}

/** A real test outcome (performed by the main process), or nothing. */
export function TestOutcome({ test }: { test: TestRecord | null }) {
  if (!test) return null
  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-[12px] leading-relaxed',
        test.status === 'connected' ? 'border-[#d7e8dc] bg-[#f4faf6]' : 'border-[#ecdcde] bg-[#faf3f4]'
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDotTest color={test.status === 'connected' ? 'bg-[#157f3d]' : 'bg-[#c22f3d]'} />
        <span className="font-medium text-[#1c1d21]">{test.message}</span>
      </div>
      <p className="mt-1 text-[11px] text-[#8b8c95]">
        {test.status === 'connected' ? 'Verified' : 'Failed'} {formatDateTime(test.at)}
        {test.durationMs ? ` · took ${formatDuration(test.durationMs)}` : ''}
      </p>
      {test.hint ? (
        <p className="mt-1 select-text font-mono text-[11px] text-[#6f707a]">{test.hint}</p>
      ) : null}
    </div>
  )
}

export function VerifiedTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f6ec] px-2 py-px text-[10.5px] font-medium text-[#157f3d]">
      <CircleCheckIcon size={11} strokeWidth={2.4} />
      verified
    </span>
  )
}
