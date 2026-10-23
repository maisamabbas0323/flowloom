import { NODE_LIBRARY, getNodeType, type NodeTypeId } from '../../../../shared/nodeSchema'
import { cn } from '../../lib/cn'
import { nodeDisplay } from './nodeDisplay'

/**
 * The node library: every supported type with a small icon and a
 * concise description. Items can be clicked (placed at the visible
 * canvas center) or dragged onto the canvas (placed at the drop point).
 * Multiple instances of every type are allowed.
 */
export function NodePalette({
  onPick,
  onDragStartType,
  onClose
}: {
  onPick: (typeId: NodeTypeId) => void
  onDragStartType: (typeId: NodeTypeId, event: React.DragEvent) => void
  onClose: () => void
}) {
  return (
    <div
      role="dialog"
      aria-label="Node library"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
      className="absolute left-3 top-3 z-20 w-[248px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[#e3e4e8] bg-white shadow-[0_8px_28px_rgba(20,20,24,0.12)]"
    >
      <p className="border-b border-[#f0f0f3] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#a2a3ac]">
        Node library
      </p>
      <ul className="max-h-[420px] overflow-y-auto py-1">
        {NODE_LIBRARY.map((typeId) => {
          const meta = nodeDisplay[typeId]
          const definition = getNodeType(typeId)
          const Icon = meta.icon
          return (
            <li key={typeId}>
              <button
                type="button"
                draggable
                onDragStart={(event) => onDragStartType(typeId, event)}
                onClick={() => onPick(typeId)}
                title={`Drag onto the canvas or click to add — ${definition.description}`}
                className={cn(
                  'group flex w-full cursor-grab items-center gap-2.5 px-3 py-2 text-left',
                  'transition-colors duration-100 hover:bg-[#f6f6f8] active:cursor-grabbing',
                  'focus-visible:outline-none focus-visible:bg-[#f6f6f8] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3f4cc0]/40'
                )}
              >
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
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[#1c1d21]">
                    {definition.label}
                  </span>
                  <span className="block truncate text-[10.5px] leading-snug text-[#8b8c95]">
                    {definition.description}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
