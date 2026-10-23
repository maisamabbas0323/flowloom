import { useState } from 'react'
import { Check as CheckIcon, Globe as GlobeIcon } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { SectionCard } from '../../components/ui/Micro'
import { Field } from '../../components/ui/Field'
import { TextInput, SecretInput } from '../../components/ui/TextInput'
import { getApi } from '../../lib/api'
import { clearAndRefreshKeyed } from './shared'
import { StatusChip, TestOutcome } from './Status'
import { browserStatus } from './settingsSupport'
import type {
  AppConfigView,
  ConnectionTestResult,
  TestRecord
} from '../../../../shared/contracts'

/**
 * Browser automation settings. Verification creates one minimal,
 * temporary Browserbase session against the supplied project and closes
 * it again — nothing opens merely by visiting Settings.
 */
export function BrowserSection({ config, onRefresh }: { config: AppConfigView; onRefresh: () => Promise<void> }) {
  const b = config.browser
  const [keyDraft, setKeyDraft] = useState('')
  const [projectIdDraft, setProjectIdDraft] = useState(b.projectId.value)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [testing, setTesting] = useState(false)
  const [liveResult, setLiveResult] = useState<ConnectionTestResult | null>(null)

  const status = browserStatus(config, testing)
  const lastTest: TestRecord | null = config.tests.browser ?? null

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const result = await getApi().saveBrowserSettings({
        apiKey: touched['apiKey'] && keyDraft.trim() !== '' ? keyDraft : undefined,
        projectId: touched['projectId'] ? projectIdDraft : undefined
      })
      if (!result.ok) setErrors(result.errors)
      else {
        setSavedFlash(true)
        window.setTimeout(() => setSavedFlash(false), 1800)
        setTouched({})
        setKeyDraft('')
        await onRefresh()
      }
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setLiveResult(null)
    try {
      const result = (await getApi().testConnection('browser')) as ConnectionTestResult
      setLiveResult(result)
      await onRefresh()
    } finally {
      setTesting(false)
    }
  }

  return (
    <SectionCard title="Browser automation">
      <div className="flex flex-col gap-5">
        <p className="max-w-[600px] text-[12px] leading-relaxed text-[#8b8c95]">
          Browser steps in your workflows run in real headless chromium on Browserbase. Each step
          execution creates one short-lived session against your project ID; Flowloom releases it
          when the step finishes, fails, or is cancelled. Nothing runs just by visiting Settings;
          verify the connection explicitly to test.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Browserbase API key"
            error={errors['apiKey']}
            source={b.apiKey.configured ? b.apiKey.source : undefined}
            onClearOverride={
              b.apiKey.source === 'settings' || b.apiKey.source === 'session'
                ? clearAndRefreshKeyed('browser.apiKey', onRefresh)
                : null
            }
          >
            <SecretInput
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value)
                setTouched((t) => ({ ...t, apiKey: true }))
              }}
              placeholder={b.apiKey.configured ? 'Saved — type to replace' : 'Paste a Browserbase API key'}
              invalid={Boolean(errors['apiKey'])}
            />
          </Field>
          <Field
            label="Project ID"
            description="From your Browserbase dashboard. Tests run inside this exact project."
            error={errors['projectId']}
            source={b.projectId.source}
            onClearOverride={b.projectId.source === 'settings' ? clearAndRefreshKeyed('browser.projectId', onRefresh) : null}
          >
            <TextInput
              value={projectIdDraft}
              onChange={(event) => {
                setProjectIdDraft(event.target.value)
                setTouched((t) => ({ ...t, projectId: true }))
              }}
              placeholder={b.projectId.source === 'unset' ? 'Enter the project ID from Browserbase' : 'Editing replaces the saved override'}
              spellCheck={false}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-[#f0f0f3] pt-4">
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save settings
          </Button>
          {savedFlash ? (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[#157f3d]">
              <CheckIcon size={13} strokeWidth={2.2} /> Saved
            </span>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="secondary"
            busy={testing}
            disabled={status === 'unconfigured'}
            onClick={() => void runTest()}
            title={status === 'unconfigured' ? 'Save the API key and project ID first' : 'Creates and closes one temporary session'}
          >
            <GlobeIcon size={14} strokeWidth={2} />
            Test connection
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          <StatusChip status={status} />
          {liveResult ?? lastTest ? <TestOutcome test={liveResult ?? lastTest} /> : null}
        </div>
      </div>
    </SectionCard>
  )
}
