import { useState } from 'react'
import { ShieldCheck as ShieldIcon } from 'lucide-react'
import { SectionCard, Toggle } from '../../components/ui/Micro'
import { getApi } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { AppConfigView } from '../../../../shared/contracts'

/** General application preferences — only what exists today. */
export function GeneralSection({ config, onRefresh }: { config: AppConfigView; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const pref = config.general.reopenLastWorkflow

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      await getApi().saveGeneralSettings({ reopenLastWorkflow: enabled })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard title="General">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="max-w-[440px]">
            <p className="text-[13px] font-medium text-[#1c1d21]">Reopen last workflow at startup</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#8b8c95]">
              When Flowloom starts, open the workflow you last had open. Saved immediately; takes
              effect at the next launch.
            </p>
          </div>
          <Toggle
            checked={pref.enabled}
            onChange={(next) => void toggle(next)}
            disabled={busy}
            label="Reopen last workflow at startup"
          />
        </div>

        <div className="rounded-lg border border-[#e6e6ea] bg-[#fafafa] p-3 text-[11.5px] leading-relaxed text-[#6f707a]">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#3d3e45]">
            <ShieldIcon size={13} strokeWidth={2} className="text-[#157f3d]" />
            Credentials and storage
          </div>
          <ul className="mt-1.5 list-disc pl-4">
            <li>Saved API keys live encrypted in this system's credential store; nothing is stored unencrypted.</li>
            <li>Environment values are read only from the .env file — Flowloom never writes to it.</li>
            <li>Workflow records are plain JSON files inside the application data directory.</li>
          </ul>
        </div>

        <dl className="flex flex-col text-[11.5px] text-[#8b8c95]">
          <Row label="App version" value={config.capabilities.appVersion} />
          <Row label="Platform" value={config.capabilities.platform} />
          <Row label="Environment file" value={config.capabilities.envFilePath ?? 'not found'} mono={Boolean(config.capabilities.envFilePath)} />
          {config.tests.model ? (
            <Row label="Last language test" value={`${formatDateTime(config.tests.model.at)} — ${config.tests.model.status}`} />
          ) : (
            <Row label="Last language test" value="not run yet" />
          )}
        </dl>
      </div>
    </SectionCard>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#f4f4f5] py-1.5 last:border-none">
      <dt>{label}</dt>
      <dd className={mono ? 'select-text font-mono text-[11px] text-[#5d5e66]' : 'font-medium text-[#3d3e45]'}>{value}</dd>
    </div>
  )
}
