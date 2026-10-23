import { useState } from 'react'
import {
  Workflow as WorkflowIcon,
  Volume2 as VolumeIcon,
  Globe as GlobeIcon,
  PenLine as PaperIcon,
  SlidersHorizontal as GeneralIcon,
  TerminalSquare as EnvIcon,
  ShieldCheck as ShieldCheckIcon,
  ShieldAlert as ShieldAlertIcon,
  Copy as CopyIcon,
  Check as CheckIcon
} from 'lucide-react'
import { Page } from './WorkflowsPage'
import { LanguageEngineSection } from './settings/LanguageEngineSection'
import { VoiceSection } from './settings/VoiceSection'
import { BrowserSection } from './settings/BrowserSection'
import { PaperSection } from './settings/PaperSection'
import { GeneralSection } from './settings/GeneralSection'
import { cn } from '../lib/cn'
import type { AppConfigView } from '../../../shared/contracts'

const SECTIONS = [
  {
    id: 'languages',
    label: 'Language engine',
    icon: WorkflowIcon,
    description: 'Where text-model steps run, and the connection check that proves it.'
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: VolumeIcon,
    description: 'ElevenLabs narration: credentials, voice choice, and spoken run feedback.'
  },
  {
    id: 'browser',
    label: 'Browser automation',
    icon: GlobeIcon,
    description: 'Browserbase credentials for real browser steps in your workflows.'
  },
  {
    id: 'paper',
    label: 'Paper Instruments',
    icon: PaperIcon,
    description: 'The Paper Instruments model provider, its spending stop, and real checks.'
  },
  {
    id: 'general',
    label: 'General',
    icon: GeneralIcon,
    description: 'Editor behavior and app preferences for this machine.'
  }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsPage({
  config,
  configError,
  loading,
  onRefresh
}: {
  config: AppConfigView | null
  configError: string | null
  loading: boolean
  onRefresh: () => Promise<void>
}) {
  const [active, setActive] = useState<SectionId>('languages')

  if (loading) {
    return (
      <Page title="Settings" subtitle="Loading configuration…">
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[#a2a3ac]">
          Reading the configuration service…
        </div>
      </Page>
    )
  }
  if (!config) {
    return (
      <Page title="Settings">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-[13px] font-medium text-[#c22f3d]">Configuration could not be loaded.</p>
          <p className="max-w-[420px] text-[12px] text-[#8b8c95]">{configError}</p>
          <button
            className="mt-1 rounded-md border border-[#d8d8dd] bg-white px-3 py-1.5 text-[12px] font-medium hover:border-[#b9bac2]"
            onClick={() => void onRefresh()}
          >
            Try again
          </button>
        </div>
      </Page>
    )
  }

  const activeSection = SECTIONS.find((section) => section.id === active) ?? SECTIONS[0]

  return (
    <Page title="Settings" subtitle="Providers, voice, browser automation, and preferences.">
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-6">
        {/* Section nav: a horizontal chip row on narrow windows, a
            vertical list (with the Environment card) on wide ones. */}
        <nav
          className="flex shrink-0 gap-1.5 overflow-x-auto pb-1 lg:w-[200px] lg:flex-col lg:gap-1 lg:overflow-x-visible lg:pb-0"
          aria-label="Settings sections"
        >
          {SECTIONS.map((section) => {
            const Icon = section.icon
            const activeItem = active === section.id
            return (
              <button
                key={section.id}
                onClick={() => setActive(section.id)}
                aria-current={activeItem ? 'true' : undefined}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-[12.5px] font-medium transition-colors duration-100',
                  activeItem
                    ? 'border border-[#e6e6ea] bg-white text-[#1c1d21] shadow-[0_1px_2px_rgba(20,20,24,0.05)]'
                    : 'border border-transparent text-[#6f707a] hover:bg-[#f0f0f3] hover:text-[#1c1d21]'
                )}
              >
                <Icon size={14} strokeWidth={2} />
                {section.label}
              </button>
            )
          })}

          <EnvironmentCard path={config.capabilities.envFilePath} secure={config.capabilities.secureStorageAvailable} />
        </nav>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-4 lg:overflow-y-auto lg:pb-4 lg:pr-1">
          <div className="flex w-full max-w-[720px] items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#e6e6ea] bg-white text-[#5d5e66] shadow-[0_1px_2px_rgba(20,20,24,0.04)]">
              <activeSection.icon size={14} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[14.5px] font-semibold tracking-tight text-[#1c1d21]">
                {activeSection.label}
              </h2>
              <p className="text-[12px] leading-relaxed text-[#8b8c95]">
                {activeSection.description}
              </p>
            </div>
          </div>
          {active === 'languages' ? (
            <div className="w-full max-w-[720px]">
              <LanguageEngineSection config={config} onRefresh={onRefresh} />
            </div>
          ) : null}
          {active === 'voice' ? (
            <div className="w-full max-w-[720px]">
              <VoiceSection config={config} onRefresh={onRefresh} />
            </div>
          ) : null}
          {active === 'browser' ? (
            <div className="w-full max-w-[720px]">
              <BrowserSection config={config} onRefresh={onRefresh} />
            </div>
          ) : null}
          {active === 'paper' ? (
            <div className="w-full max-w-[720px]">
              <PaperSection config={config} onRefresh={onRefresh} />
            </div>
          ) : null}
          {active === 'general' ? (
            <div className="w-full max-w-[720px]">
              <GeneralSection config={config} onRefresh={onRefresh} />
            </div>
          ) : null}
        </div>
      </div>
    </Page>
  )
}

/**
 * Environment card: where config values come from on this machine,
 * plus the credential-storage story. The file path is selectable and
 * copyable; the storage state is stated truthfully (session-only keys
 * when secure storage is missing).
 */
function EnvironmentCard({ path, secure }: { path: string | null; secure: boolean }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — the path stays selectable by hand */
    }
  }

  return (
    <div className="mt-2 flex w-full flex-col gap-2.5 rounded-xl border border-[#e6e6ea] bg-white p-3 shadow-[0_1px_2px_rgba(20,20,24,0.04)] lg:mt-4">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8b8c95]">
        <EnvIcon size={12} strokeWidth={2} />
        Environment
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[11.5px] leading-relaxed text-[#8b8c95]">Environment file</p>
        {path ? (
          <div className="flex items-start gap-1.5">
            <code
              className="min-w-0 flex-1 select-text break-all rounded-md bg-[#f4f4f5] px-2 py-1 font-mono text-[10.5px] leading-relaxed text-[#5d5e66]"
              title={path}
            >
              {path}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              title={copied ? 'Copied' : 'Copy the environment file path'}
              aria-label={copied ? 'Copied' : 'Copy the environment file path'}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#8b8c95] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c1d21]"
            >
              {copied ? (
                <CheckIcon size={12} strokeWidth={2.2} className="text-[#157f3d]" />
              ) : (
                <CopyIcon size={12} strokeWidth={2} />
              )}
            </button>
          </div>
        ) : (
          <p className="text-[11.5px] italic leading-relaxed text-[#8b8c95]">
            No .env file found — Settings values apply.
          </p>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed">
        {secure ? (
          <>
            <ShieldCheckIcon size={13} strokeWidth={2} className="mt-px shrink-0 text-[#157f3d]" />
            <span className="text-[#4b6442]">
              Secure storage available — API keys are encrypted at rest.
            </span>
          </>
        ) : (
          <>
            <ShieldAlertIcon size={13} strokeWidth={2} className="mt-px shrink-0 text-[#a05a12]" />
            <span className="text-[#7a5a24]">
              No secure storage on this system — typed keys stay session-only.
            </span>
          </>
        )}
      </div>
    </div>
  )
}
