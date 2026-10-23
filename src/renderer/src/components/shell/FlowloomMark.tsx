import { cn } from '../../lib/cn'

/**
 * The app identity for light page headers: the woven-thread mark plus
 * the Flowloom wordmark, parked at the top right of every page.
 */
export function FlowloomBrand({ className }: { className?: string }) {
  return (
    <span
      className={cn('flex shrink-0 select-none items-center gap-2', className)}
      title="Flowloom"
      aria-label="Flowloom"
    >
      <FlowloomMark size={22} />
      <span className="hidden text-[12.5px] font-semibold tracking-tight text-[#1c1d21] sm:inline">
        Flowloom
      </span>
    </span>
  )
}

export function FlowloomMark({ size = 24 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-[9px] border border-[#2b2d33] bg-[#212227] text-white shadow-inner"
      style={{ width: size, height: size }}
    >
      {/* woven-thread monogram */}
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3 3.5h10M3 8h7"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M13 8c0 3-2.2 4.5-4.4 4.5C6 12.5 3.6 11.2 3 9.4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
