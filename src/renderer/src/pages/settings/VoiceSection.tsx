import { useEffect, useRef, useState } from 'react'
import { Check as CheckIcon, Play as PlayIcon, Volume2 as VolumeIcon } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { SectionCard, Toggle } from '../../components/ui/Micro'
import { Field } from '../../components/ui/Field'
import { TextInput, SecretInput, SelectInput } from '../../components/ui/TextInput'
import { getApi } from '../../lib/api'
import { clearAndRefreshKeyed } from './shared'
import { StatusChip, TestOutcome } from './Status'
import { voiceStatus } from './settingsSupport'
import type { AppConfigView, ConnectionTestResult, VoiceTestResult } from '../../../../shared/contracts'
import type { TestRecord } from '../../../../shared/contracts'

/**
 * Voice settings: real ElevenLabs verification plus a genuine TTS test
 * with the user-supplied voice id. Generated audio plays locally and is
 * never persisted; the API key never appears in any URL.
 */
export function VoiceSection({ config, onRefresh }: { config: AppConfigView; onRefresh: () => Promise<void> }) {
  const v = config.voice
  const [keyDraft, setKeyDraft] = useState('')
  const [voiceIdDraft, setVoiceIdDraft] = useState(v.voiceId.value)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [liveResult, setLiveResult] = useState<VoiceTestResult | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Never leak the audio object URL across tests or unmounts.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  const status = voiceStatus(config, busy)
  const lastTest: TestRecord | null = config.tests.voice ?? null

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const result = await getApi().saveVoiceSettings({
        apiKey: touched['apiKey'] && keyDraft.trim() !== '' ? keyDraft : undefined,
        voiceId: touched['voiceId'] ? voiceIdDraft : undefined
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

  const runConnectionTest = async () => {
    setBusy(true)
    setLiveResult(null)
    try {
      const result = (await getApi().testConnection('voice')) as ConnectionTestResult
      setLiveResult(result)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const runVoiceTest = async () => {
    setBusy(true)
    setLiveResult(null)
    try {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      setAudioUrl(null)
      const result = await getApi().testVoice()
      setLiveResult(result)
      if (result.audio) {
        const bytes = Uint8Array.from(atob(result.audio.base64), (ch) => ch.charCodeAt(0))
        const blob = new Blob([bytes.buffer], { type: result.audio.mimeType })
        setAudioUrl(URL.createObjectURL(blob))
      }
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  /** Honest button states: both kinds of test only run with valid config. */
  const connectionReady = v.apiKey.configured
  const voiceReady = connectionReady && (touched['voiceId'] ? voiceIdDraft.trim() !== '' : v.voiceId.value !== '')

  return (
    <SectionCard title="Voice">
      <div className="flex flex-col gap-5">
        <p className="max-w-[600px] text-[12px] leading-relaxed text-[#8b8c95]">
          Generate narration with ElevenLabs. The voice ID comes from your ElevenLabs account —
          Flowloom never invents or auto-selects voices, and speech cannot be generated until
          both the API key and the voice ID verify.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="ElevenLabs API key"
            description="From your ElevenLabs profile. Stored protected by your system's secure credential storage."
            error={errors['apiKey']}
            source={v.apiKey.configured ? v.apiKey.source : undefined}
            onClearOverride={
              v.apiKey.source === 'settings' || v.apiKey.source === 'session'
                ? clearAndRefreshKeyed('voice.apiKey', onRefresh)
                : null
            }
          >
            <SecretInput
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value)
                setTouched((t) => ({ ...t, apiKey: true }))
              }}
              placeholder={v.apiKey.configured ? 'Saved — type to replace' : 'Paste an ElevenLabs API key'}
              invalid={Boolean(errors['apiKey'])}
            />
          </Field>
          <Field
            label="Voice ID"
            description="Exactly as your account supplies it (open the Voice Library → copy voice ID)."
            error={errors['voiceId']}
            source={v.voiceId.source}
            onClearOverride={v.voiceId.source === 'settings' ? clearAndRefreshKeyed('voice.voiceId', onRefresh) : null}
          >
            <TextInput
              value={voiceIdDraft}
              onChange={(event) => {
                setVoiceIdDraft(event.target.value)
                setTouched((t) => ({ ...t, voiceId: true }))
              }}
              placeholder={v.voiceId.source === 'unset' ? 'Enter the voice ID supplied by your account' : 'Editing replaces the saved override'}
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
            busy={busy}
            disabled={!connectionReady}
            onClick={() => void runConnectionTest()}
            title={connectionReady ? 'Verifies the API key against ElevenLabs' : 'Save an API key first'}
          >
            <VolumeIcon size={14} strokeWidth={2} />
            Test connection
          </Button>
          <Button
            variant="secondary"
            busy={busy}
            disabled={!voiceReady}
            onClick={() => void runVoiceTest()}
            title={voiceReady ? 'Generates a short sample with your voice ID' : 'Needs a saved API key and a voice ID'}
          >
            <PlayIcon size={14} strokeWidth={2} />
            Test voice
          </Button>
        </div>

        <StatusChip status={status} />

        {liveResult ? <TestOutcome test={resultAsRecord(liveResult)} /> : lastTest ? <TestOutcome test={lastTest} /> : null}

        <NarrationGroup config={config} onRefresh={onRefresh} />

        {audioUrl ? (
          <div className="rounded-lg border border-[#d7e8dc] bg-[#f4faf6] p-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[#1c1d21]">
              <VolumeIcon size={13} strokeWidth={2} className="text-[#157f3d]" />
              Sample audio is ready — playing with your system volume.
            </div>
            <audio ref={audioRef} src={audioUrl} controls className="mt-2 h-8 w-full max-w-[360px]" />
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}

function resultAsRecord(result: VoiceTestResult | ConnectionTestResult): TestRecord {
  return {
    status: result.status,
    code: result.code,
    message: result.message,
    hint: 'hint' in result ? (result as ConnectionTestResult).hint : undefined,
    at: result.at,
    durationMs: 0
  }
}

const NARRATION_SPEEDS = [0.75, 1, 1.25, 1.5] as const

/**
 * Optional run narration preferences. Each change saves immediately and
 * re-reads the real config before flipping local state, so the toggles
 * always display the actual persisted value.
 */
function NarrationGroup({ config, onRefresh }: { config: AppConfigView; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const narration = config.voice.narration

  const save = async (patch: Partial<typeof narration>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await getApi().saveVoiceSettings({
        narrationEnabled: patch.enabled,
        narrationSuccesses: patch.successes,
        narrationIssues: patch.issues,
        narrationBrowser: patch.browser,
        narrationSpeed: patch.speed
      })
      if (!result.ok) setError(result.errors['narrationSpeed'] ?? Object.values(result.errors)[0] ?? 'The preference could not be saved.')
      else await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-[#e6e6ea] bg-[#fafafa] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="max-w-[460px]">
          <p className="text-[13px] font-medium text-[#1c1d21]">Voice feedback during workflow runs</p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#8b8c95]">
            Speaks short, factual status lines ("Workflow started.", "The browser step has finished.")
            with your verified voice. Never page content, never credentials. Speech generation is
            optional — workflows run identically without it — and each announcement is one real
            ElevenLabs request.
          </p>
        </div>
        <Toggle
          checked={narration.enabled}
          onChange={(next) => void save({ enabled: next })}
          disabled={busy}
          label="Voice feedback during workflow runs"
        />
      </div>

      {narration.enabled ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-[#ececef] pt-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] font-medium text-[#3d3e45]">Run started / completed</p>
              <p className="text-[11px] leading-snug text-[#8b8c95]">
                Announces when a workflow starts and succeeds.
              </p>
            </div>
            <Toggle
              checked={narration.successes}
              onChange={(next) => void save({ successes: next })}
              disabled={busy}
              label="Speak run start and completion"
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] font-medium text-[#3d3e45]">Failures / cancellations</p>
              <p className="text-[11px] leading-snug text-[#8b8c95]">
                Announces when a workflow fails or is cancelled.
              </p>
            </div>
            <Toggle
              checked={narration.issues}
              onChange={(next) => void save({ issues: next })}
              disabled={busy}
              label="Speak failures and cancellations"
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] font-medium text-[#3d3e45]">Browser step finished</p>
              <p className="text-[11px] leading-snug text-[#8b8c95]">
                Announces each finished or failed browser step by name.
              </p>
            </div>
            <Toggle
              checked={narration.browser}
              onChange={(next) => void save({ browser: next })}
              disabled={busy}
              label="Speak finished browser steps"
            />
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="narration-speed" className="text-[12px] font-medium text-[#3d3e45]">
              Playback speed
            </label>
            <SelectInput
              id="narration-speed"
              value={String(narration.speed)}
              disabled={busy}
              aria-label="Narration playback speed"
              onChange={(event) => void save({ speed: Number(event.target.value) })}
              base="h-8 w-[96px] cursor-pointer appearance-none rounded-lg px-2.5 pr-7 text-[12px]"
            >
              {NARRATION_SPEEDS.map((speed) => (
                <option key={speed} value={String(speed)}>
                  {speed === 1 ? 'Normal' : `${speed}×`}
                </option>
              ))}
            </SelectInput>
            <span className="text-[11px] text-[#8b8c95]">Applied locally during playback.</span>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[11.5px] text-[#b42318]">{error}</p> : null}
    </div>
  )
}
