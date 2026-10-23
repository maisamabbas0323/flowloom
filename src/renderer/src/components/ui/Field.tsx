import type { ReactNode } from 'react'
import { RotateCcw as ResetIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { AppConfigView, ValueSource } from '../../../../shared/contracts'
import { IconButton } from './Button'

const SOURCE_TEXT: Record<ValueSource | 'session', string> = {
  settings: 'Saved in Flowloom',
  env: 'From .env file',
  default: 'Default',
  unset: 'Not set',
  session: 'This session only'
}

export function SourceBadge({ source }: { source: AppConfigView['model']['provider']['source'] | 'session' }) {
  const tone =
    source === 'unset' ? 'muted' : source === 'default' ? 'muted' : source === 'session' ? 'warn' : 'plain'
  return (
    <span
      className={cn(
        'inline-flex h-4.5 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium',
        tone === 'plain' && 'bg-[#f4f4f5] text-[#6f707a]',
        tone === 'muted' && 'bg-transparent text-[#a2a3ac] border border-dashed border-[#d8d8dd]',
        tone === 'warn' && 'bg-[#fbf2e5] text-[#a05a12]'
      )}
    >
      {SOURCE_TEXT[source]}
    </span>
  )
}

export interface FieldProps {
  label: ReactNode
  description?: ReactNode
  error?: string
  source?: ValueSource | 'session'
  /** Offered when the field currently shows a saved override. */
  onClearOverride?: (() => void) | null
  children: ReactNode
}

export function Field({ label, description, error, source, onClearOverride, children }: FieldProps) {
  const canClear = onClearOverride !== null && onClearOverride !== undefined
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex items-center gap-2 text-[12.5px] font-medium text-[#3d3e45]">
        <span>{label}</span>
        {source ? <SourceBadge source={source} /> : null}
        {canClear ? (
          <IconButton
            label={
              source === 'session'
                ? 'Remove the saved credential from this session'
                : 'Remove the saved override — the .env value becomes effective again'
            }
            className="h-6 w-6 rounded-md"
            onClick={onClearOverride}
          >
            <ResetIcon size={12} strokeWidth={2} />
          </IconButton>
        ) : null}
      </label>
      {description ? <p className="text-[11.5px] leading-relaxed text-[#8b8c95]">{description}</p> : null}
      <div>{children}</div>
      {error ? <p className="text-[11.5px] font-medium text-[#c22f3d]">{error}</p> : null}
    </div>
  )
}

/* The Environment card in SettingsPage renders the .env + secure-storage
   story; the Field primitives above stay focused on labelled inputs. */
