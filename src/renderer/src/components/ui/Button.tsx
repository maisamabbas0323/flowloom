import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader as LoaderIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger-ghost'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  busy?: boolean
}

const variantClass: Record<Variant, string> = {
  primary: cn(
    'bg-[#1d1e23] text-white border border-[#1d1e23]',
    'hover:bg-black hover:border-black',
    'disabled:bg-[#e8e8ec] disabled:text-[#a2a3ac] disabled:border-[#e8e8ec]'
  ),
  secondary: cn(
    'bg-white text-[#1c1d21] border border-[#d8d8dd]',
    'hover:border-[#b9bac2] hover:bg-[#fafafa]',
    'disabled:text-[#a2a3ac] disabled:border-[#e8e8ec] disabled:bg-white'
  ),
  ghost: cn('bg-transparent text-[#3d3e45] border border-transparent', 'hover:bg-[#f0f0f3]'),
  'danger-ghost': cn('bg-white text-[#c22f3d] border border-[#e6d5d7]', 'hover:bg-[#fbeaec] hover:border-[#e5c0c5]')
}

const sizeClass: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-lg'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', busy = false, className, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap font-medium select-none',
        'transition-colors duration-100',
        variantClass[variant],
        sizeClass[size],
        className
      )}
      {...props}
    >
      {busy ? <LoaderIcon size={13} strokeWidth={2.2} className="animate-spin" /> : null}
      {children}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  busy?: boolean
  /** Renders the pressed/toggled style (e.g. active toolbar toggles). */
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, busy, active, className, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled || busy}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#43444a]',
        'border border-transparent transition-colors duration-100',
        'hover:bg-[#f0f0f3] hover:text-[#1c1d21]',
        active && 'bg-[#eef0fb] text-[#3f4cc0]',
        busy && 'cursor-progress text-[#a2a3ac]',
        disabled && 'cursor-not-allowed text-[#c9cad1]',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
})
