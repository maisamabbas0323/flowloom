import {
  Workflow as WorkflowIcon,
  FolderOpen as FolderIcon,
  History as HistoryIcon,
  Settings as SettingsIcon
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { FlowloomMark } from './FlowloomMark'

export type Route = 'editor' | 'workflows' | 'history' | 'settings'

const ITEMS: Array<{ id: Route; label: string; icon: typeof WorkflowIcon }> = [
  { id: 'editor', label: 'Editor', icon: WorkflowIcon },
  { id: 'workflows', label: 'Workflows', icon: FolderIcon },
  { id: 'history', label: 'Run history', icon: HistoryIcon }
]

export function NavRail({
  active,
  onNavigate
}: {
  active: Route
  onNavigate: (route: Route) => void
}) {
  return (
    <nav
      className="flex h-full w-[56px] shrink-0 flex-col items-center gap-1 border-r border-[#101114] bg-[#17181c] py-3"
      aria-label="Primary"
    >
      <button
        className="mb-3 focus-visible:outline-offset-4"
        title="Flowloom"
        aria-label="Flowloom — go to editor"
        onClick={() => onNavigate('editor')}
      >
        <FlowloomMark />
      </button>

      {ITEMS.map((item) => {
        const Icon = item.icon
        const isActive = active === item.id
        return (
          <button
            key={item.id}
            title={item.label}
            aria-label={item.label}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
            className={cn(
              'relative flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors duration-100',
              isActive
                ? 'bg-[#2e3036] text-white'
                : 'text-[#87898f] hover:bg-[#232529] hover:text-[#c6c7cc]'
            )}
          >
            <Icon size={18} strokeWidth={1.9} />
            {isActive ? (
              <span className="absolute -left-[7px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-[#5c66e0]" />
            ) : null}
          </button>
        )
      })}

      <div className="mt-auto flex flex-col items-center gap-1">
        <RailButton
          label="Settings"
          active={active === 'settings'}
          onClick={() => onNavigate('settings')}
        >
          <SettingsIcon size={18} strokeWidth={1.9} />
        </RailButton>
      </div>
    </nav>
  )
}

function RailButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors duration-100',
        active ? 'bg-[#2e3036] text-white' : 'text-[#87898f] hover:bg-[#232529] hover:text-[#c6c7cc]'
      )}
    >
      {children}
    </button>
  )
}
