import {
  forwardRef,
  useState,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { Eye as EyeIcon, EyeOff as EyeOffIcon, Dot as DotIcon, ChevronDown as ChevronIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

/**
 * The single field material every Flowloom input is made of: a softly
 * raised white surface, a warm hairline border, an accent caret, and a
 * glow that blooms on focus. Inputs, textareas and selects all share
 * it, so typing anywhere in the app feels like the same substance.
 */
export function fieldShell({
  invalid,
  className,
  base
}: {
  invalid?: boolean
  className?: string
  base?: string
} = {}): string {
  const state = invalid
    ? 'border-[#e0a9af] hover:border-[#d67f88] focus-visible:border-[#c22f3d] focus-visible:ring-[#c22f3d]/10'
    : 'border-[#dcdde2] hover:border-[#b9bac2] focus-visible:border-[#3f4cc0] focus-visible:ring-[#3f4cc0]/10'
  return cn(
    base ?? 'h-10 w-full rounded-[10px] px-3 text-[13px] leading-5',
    'border bg-white text-[#1c1d21]',
    'shadow-[0_1px_2px_rgba(23,24,28,0.04)] caret-[#3f4cc0]',
    'placeholder:text-[#a2a3ac] selection:bg-[#dfe3f8]',
    'transition-[border-color,box-shadow] duration-150 outline-none',
    'focus-visible:ring-4',
    state,
    'disabled:cursor-not-allowed disabled:border-[#e8e8ec] disabled:bg-[#f6f6f8] disabled:text-[#a2a3ac] disabled:shadow-none',
    /* Chrome paints autofill fields its own yellow — re-skin them. */
    '[&:-webkit-autofill]:shadow-[0_1px_2px_rgba(23,24,28,0.04),0_0_0_1000px_white_inset]',
    className
  )
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, invalid, ...props },
  ref
) {
  return <input ref={ref} className={fieldShell({ invalid, className })} {...props} />
})

/**
 * Secret input: masked by default with a working reveal/hide control.
 * It never receives an existing secret value from the renderer — only a
 * fresh typed value goes back over IPC; state ("configured · from .env")
 * is shown as a badge next to the field, not as content.
 */
export const SecretInput = forwardRef<HTMLInputElement, TextInputProps>(function SecretInput(
  { className, invalid, ...props },
  ref
) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="relative">
      <input
        ref={ref}
        type={revealed ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        className={fieldShell({ invalid, className: cn('pr-10 font-mono tracking-wide', className) })}
        {...props}
      />
      <button
        type="button"
        title={revealed ? 'Hide value' : 'Reveal value'}
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        onClick={() => setRevealed((v) => !v)}
        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[#8b8c95] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c1d21]"
      >
        {revealed ? <EyeOffIcon size={14} strokeWidth={2} /> : <EyeIcon size={14} strokeWidth={2} />}
      </button>
    </div>
  )
})

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  invalid?: boolean
  /** Override the base sizing/typography classes (heights differ per use). */
  base?: string
  className?: string
}

/** Multi-line field made of the same material as the single-line ones. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, invalid, base, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={fieldShell({
        invalid,
        base: base ?? 'min-h-[72px] w-full resize-y rounded-[10px] px-3 py-2 text-[13px] leading-5',
        className
      })}
      {...props}
    />
  )
})

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean
  /** Override the base sizing classes (compact selects in dense rows). */
  base?: string
  className?: string
}

/** Native select, re-skinned to the field surface with a soft chevron. */
export const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput(
  { className, invalid, base, children, ...props },
  ref
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={fieldShell({
          invalid,
          base: base ?? 'h-10 w-full cursor-pointer appearance-none rounded-[10px] px-3 pr-8 text-[13px] leading-5',
          className
        })}
        {...props}
      >
        {children}
      </select>
      <ChevronIcon
        size={13}
        strokeWidth={2}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8b8c95]"
      />
    </div>
  )
})

/** Small inline note ("Optional", etc.) used inside labels. */
export function LabelHint({ children }: { children: React.ReactNode }) {
  return <span className="font-normal text-[#a2a3ac]">{children}</span>
}

export function OptionalTag({ children }: { children?: React.ReactNode }) {
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-[#f4f4f5] px-1.5 py-px text-[10px] font-medium text-[#8b8c95]">
      <DotIcon size={10} />
      {children ?? 'Optional'}
    </span>
  )
}
