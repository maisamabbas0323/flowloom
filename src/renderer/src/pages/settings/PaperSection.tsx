import { useEffect, useState } from 'react'
import { Check as CheckIcon, PlugZap as PlugIcon, PenLine as PenIcon } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { SectionCard, Toggle } from '../../components/ui/Micro'
import { Field } from '../../components/ui/Field'
import { TextInput, SecretInput } from '../../components/ui/TextInput'
import { getApi } from '../../lib/api'
import { clearAndRefreshKeyed } from './shared'
import { StatusChip, TestOutcome } from './Status'
import { paperStatus } from './settingsSupport'
import type { AppConfigView, ConnectionTestResult } from '../../../../shared/contracts'
import type { TestRecord } from '../../../../shared/contracts'

/**
 * Paper Instruments (Ultramarine API) settings. "Test connection" runs
 * the three documented, unbilled GETs (/v1/models, model lookup, and
 * /v1/usage — the real prepaid balance, verbatim). "Test generation"
 * performs one small real billable chat completion and only ever runs
 * when the user presses it. The API key is stored in protected secure
 * storage; the model ID is never guessed by Flowloom.
 */
export function PaperSection({ config, onRefresh }: { config: AppConfigView; onRefresh: () => Promise<void> }) {
  const paper = config.paper
  const [keyDraft, setKeyDraft] = useState('')
  const [modelDraft, setModelDraft] = useState(paper.model.value)
  const [minBalanceDraft, setMinBalanceDraft] = useState(
    Number.isFinite(paper.preferences.minBalanceUsd) ? String(paper.preferences.minBalanceUsd) : '0'
  )
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [liveResult, setLiveResult] = useState<ConnectionTestResult | null>(null)

  // Re-sync drafts when a refresh brings different real values.
  useEffect(() => {
    setModelDraft(paper.model.value)
  }, [paper.model.value])
  useEffect(() => {
    setMinBalanceDraft(
      Number.isFinite(paper.preferences.minBalanceUsd) ? String(paper.preferences.minBalanceUsd) : '0'
    )
  }, [paper.preferences.minBalanceUsd])

  const { status, missing } = paperStatus(config, busy)
  const lastTest: TestRecord | null = config.tests.paper ?? null

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const parsedBalance = Number(minBalanceDraft)
      const result = await getApi().savePaperSettings({
        apiKey: touched['apiKey'] && keyDraft.trim() !== '' ? keyDraft : undefined,
        model: touched['model'] ? (modelDraft.trim() === '' ? null : modelDraft) : undefined,
        minBalanceUsd:
          touched['minBalanceUsd'] && minBalanceDraft.trim() !== '' && Number.isFinite(parsedBalance)
            ? parsedBalance
            : undefined
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

  /** Free, documented verification — never reaches chat/completions. */
  const runConnectionTest = async () => {
    setBusy(true)
    setLiveResult(null)
    try {
      const result = (await getApi().testConnection('paper')) as ConnectionTestResult
      setLiveResult(result)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  /**
   * One small real generation (max 128 output tokens, low reasoning
   * effort). It bills prepaid credit and therefore only ever runs when
   * the model is configured and the user presses it.
   */
  const runGenerationTest = async () => {
    setBusy(true)
    setLiveResult(null)
    try {
      const result = await getApi().testPaperGeneration()
      setLiveResult(result)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const savingBalanceInvalid =
    touched['minBalanceUsd'] && minBalanceDraft.trim() !== '' && !Number.isFinite(Number(minBalanceDraft))
  const generationReady =
    paper.apiKey.configured && (touched['model'] ? modelDraft.trim() !== '' : paper.model.value !== '') && !savingBalanceInvalid

  const setEnabled = async (next: boolean) => {
    setBusy(true)
    try {
      const result = await getApi().savePaperSettings({ enabled: next })
      if (!result.ok) setErrors(result.errors)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard title="Paper Instruments">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <p className="max-w-[620px] text-[12px] leading-relaxed text-[#8b8c95]">
            Text generation with Paper Instruments models (Ultramarine API). Every generation bills
            real prepaid credit — Flowloom never starts one on its own, and the local spending stop
            below refuses a run before it starts when the balance the provider reports is under it.
          </p>
          <div className="flex max-w-[620px] items-start justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-[#1c1d21]">Enable Paper Instruments steps</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#8b8c95]">
                When off, every Paper Instruments workflow step refuses to run before any request.
              </p>
            </div>
            <Toggle
              checked={paper.preferences.enabled}
              onChange={(next) => void setEnabled(next)}
              disabled={busy}
              label="Enable Paper Instruments steps"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Paper Instruments API key"
            description="Live keys look like pi_live_… (PAPERINSTRUMENTS_API_KEY in .env). Stored in your system's protected credential storage."
            error={errors['apiKey']}
            source={paper.apiKey.configured ? paper.apiKey.source : undefined}
            onClearOverride={
              paper.apiKey.source === 'settings' || paper.apiKey.source === 'session'
                ? clearAndRefreshKeyed('paper.apiKey', onRefresh)
                : null
            }
          >
            <SecretInput
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value)
                setTouched((t) => ({ ...t, apiKey: true }))
              }}
              placeholder={paper.apiKey.configured ? 'Saved — type to replace' : 'Paste a Paper Instruments API key'}
              invalid={Boolean(errors['apiKey'])}
            />
          </Field>
          <Field
            label="Model ID"
            description="Exactly an id the provider lists under GET /v1/models (PAPERINSTRUMENTS_MODEL in .env). Flowloom never substitutes one silently."
            error={errors['model']}
            source={paper.model.source}
            onClearOverride={paper.model.source === 'settings' ? clearAndRefreshKeyed('paper.model', onRefresh) : null}
          >
            <TextInput
              value={modelDraft}
              onChange={(event) => {
                setModelDraft(event.target.value)
                setTouched((t) => ({ ...t, model: true }))
              }}
              placeholder="e.g. an id from GET /v1/models"
              spellCheck={false}
            />
          </Field>
        </div>

        <Field
          label="Local spending stop (USD)"
          description="Before a step runs, Flowloom reads the prepaid balance the provider reports and refuses when it is below this many dollars. 0 disables the pre-check — the provider's own prepaid reservation remains the primary protection. 0–100."
          error={errors['minBalanceUsd'] ?? (savingBalanceInvalid ? 'Enter 0–100 dollars.' : undefined)}
          source="default"
        >
          <div className="w-[120px]">
            <TextInput
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={minBalanceDraft}
              aria-label="Local spending stop in dollars"
              invalid={Boolean(savingBalanceInvalid)}
              onChange={(event) => {
                setMinBalanceDraft(event.target.value)
                setTouched((t) => ({ ...t, minBalanceUsd: true }))
              }}
            />
          </div>
        </Field>

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
            busy={busy}
            disabled={!paper.apiKey.configured}
            onClick={() => void runConnectionTest()}
            title={paper.apiKey.configured ? 'Checks the models list, model ID, and reports the real prepaid balance — no cost' : 'Save an API key first'}
          >
            <PlugIcon size={14} strokeWidth={2} />
            Test connection
          </Button>
          <Button
            variant="secondary"
            busy={busy}
            disabled={!generationReady}
            onClick={() => void runGenerationTest()}
            title={
              generationReady
                ? 'Runs one 128-token generation — this bills prepaid credit'
                : 'Needs a saved API key and model ID. Billing only happens when you press this.'
            }
          >
            <PenIcon size={14} strokeWidth={2} />
            Test generation (billable)
          </Button>
        </div>

        <StatusChip
          status={status}
          missing={status === 'unconfigured' ? missing : undefined}
          label={
            !paper.preferences.enabled
              ? 'Paper Instruments is switched off — steps refuse to run'
              : undefined
          }
        />

        {liveResult ? <TestOutcome test={liveResultAsRecord(liveResult)} /> : lastTest ? <TestOutcome test={lastTest} /> : null}
      </div>
    </SectionCard>
  )
}

function liveResultAsRecord(result: ConnectionTestResult): TestRecord {
  return {
    status: result.status,
    code: result.code,
    message: result.message,
    hint: result.hint,
    at: result.at,
    durationMs: 0
  }
}
