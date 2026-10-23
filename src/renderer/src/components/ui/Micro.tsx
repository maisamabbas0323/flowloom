import type { ReactNode } from 'react'
import { useEffect } from 'react'
import {
  X as XIcon,
  CircleCheck as CircleCheckIcon,
  CircleAlert as CircleAlertIcon,
  Loader as LoaderIcon,
  CircleDashed as CircleDashedIcon
} from 'lucide-react'
import { cn } from '../../lib/cn'
import type { ConnectionStatus } from '../../../../shared/contracts'
import { IconButton } from './Button'

/* ------------------------------------------------------------------ */
/* Section card                                                        */
/* ------------------------------------------------------------------ */

export function SectionCard({
  title,
  headline,
  children
}: {
  title: string
  headline?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-[#e6e6ea] bg-white p-5 shadow-[0_1px_2px_rgba(20,20,24,0.04)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14.5px] font-semibold tracking-tight text-[#1c1d21]">{title}</h2>
        {headline}
      </div>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const STATUS_META: Record<ConnectionStatus, { label: string; dot: string; text: string; bg: string }> = {
  unconfigured: {
    label: 'Not configured',
    dot: 'bg-[#b4b5bd]',
    text: 'text-[#6f707a]',
    bg: 'bg-[#f4f4f5]'
  },
  testing: {
    label: 'Testing…',
    dot: '',
    text: 'text-[#a05a12]',
    bg: 'bg-[#fbf2e5]'
  },
  connected: {
    label: 'Connection verified',
    dot: 'bg-[#157f3d]',
    text: 'text-[#157f3d]',
    bg: 'bg-[#e8f6ec]'
  },
  failed: {
    label: 'Failed',
    dot: 'bg-[#c22f3d]',
    text: 'text-[#c22f3d]',
    bg: 'bg-[#fbeaec]'
  }
}

export function StatusBadge({ status, label }: { status: ConnectionStatus; label?: string }) {
  const meta = STATUS_META[status]
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium',
        meta.text,
        meta.bg
      )}
    >
      <StatusDot status={status} />
      {label ?? meta.label}
    </span>
  )
}

/** A tiny status dot for section chips. */
export function StatusDotTest({ color, spinning }: { color: string; spinning?: boolean }) {
  if (spinning) {
    return <LoaderIcon size={12} strokeWidth={2.4} className="animate-spin text-current" />
  }
  return <span className={cn('inline-block h-2 w-2 rounded-full', color)} />
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  if (status === 'testing') {
    return <LoaderIcon size={12} strokeWidth={2.4} className="animate-spin text-[#a05a12]" />
  }
  if (status === 'connected') {
    return <CircleCheckIcon size={12} strokeWidth={2.4} />
  }
  if (status === 'failed') {
    return <CircleAlertIcon size={12} strokeWidth={2.4} />
  }
  return <CircleDashedIcon size={12} strokeWidth={2.4} />
}

/* ------------------------------------------------------------------ */
/* Toggle                                                              */
/* ------------------------------------------------------------------ */

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-100',
        checked ? 'border-[#3f4cc0] bg-[#3f4cc0]' : 'border-[#d8d8dd] bg-[#ececef]',
        disabled && 'opacity-50'
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-[left] duration-100',
          checked ? 'left-[18px]' : 'left-[2px]'
        )}
      />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Empty state                                                          */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon,
  title,
  description,
  actions,
  compact
}: {
  icon: ReactNode
  title: string
  description: ReactNode
  actions?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-2 py-8' : 'gap-3 py-12')}>
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl border border-[#e6e6ea] bg-white text-[#6f707a] shadow-[0_1px_2px_rgba(20,20,24,0.05)]">
        {icon}
      </div>
      <h3 className="text-[15px] font-semibold tracking-tight text-[#1c1d21]">{title}</h3>
      <p className="max-w-[420px] text-[12.5px] leading-relaxed text-[#8b8c95]">{description}</p>
      {actions ? <div className="mt-2 flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  children
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  // Escape closes the modal exactly like a backdrop click does.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#26262b]/25" onMouseDown={onClose}>
      <div
        className="m-4 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[#e6e6ea] bg-white p-5 shadow-[0_16px_48px_rgba(20,20,24,0.18)]"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <XIcon size={14} strokeWidth={2} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  )
}
