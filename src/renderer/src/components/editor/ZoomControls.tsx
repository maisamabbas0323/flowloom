import { useStore } from '@xyflow/react'
import { Minus as MinusIcon, Plus as PlusIcon, Scan as ScanIcon } from 'lucide-react'
import { IconButton } from '../ui/Button'

/**
 * Canvas zoom controls, bottom-left of the canvas like the reference.
 */
export function ZoomControls({
  onZoomIn,
  onZoomOut,
  onFit
}: {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}) {
  const zoom = useStore((state) => state.transform[2])
  const pct = Math.round(zoom * 100)
  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center overflow-hidden rounded-lg border border-[#e3e4e8] bg-white shadow-[0_2px_8px_rgba(20,20,24,0.07)]">
      <IconButton
        label="Zoom out"
        className="h-7 w-7 rounded-none border-r border-[#f0f0f3]"
        onClick={onZoomOut}
      >
        <MinusIcon size={13} strokeWidth={2.2} />
      </IconButton>
      <button
        type="button"
        onClick={onFit}
        title="Fit the workflow to the view"
        aria-label="Fit workflow to view"
        className="flex h-7 w-[46px] items-center justify-center gap-1 text-[10.5px] font-semibold tabular-nums text-[#43444a] transition-colors hover:bg-[#f0f0f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3f4cc0]/40 focus-visible:ring-inset"
      >
        <ScanIcon size={11} strokeWidth={2} />
        {pct}%
      </button>
      <IconButton
        label="Zoom in"
        className="h-7 w-7 rounded-none border-l border-[#f0f0f3]"
        onClick={onZoomIn}
      >
        <PlusIcon size={13} strokeWidth={2.2} />
      </IconButton>
    </div>
  )
}
