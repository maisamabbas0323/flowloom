import { useState } from 'react'
import { Check as CheckIcon, CircleCheck as CircleCheckIcon } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { SectionCard } from '../../components/ui/Micro'
import { Field } from '../../components/ui/Field'
import { TextInput, SecretInput, OptionalTag } from '../../components/ui/TextInput'
import { getApi } from '../../lib/api'
import { cn } from '../../lib/cn'
import { PROVIDER_OPTIONS, modelStatus } from './settingsSupport'
import { EffectiveLine, StatusChip, TestOutcome } from './Status'
import type {
  AppConfigView,
  ClearOverrideKey,
  ConnectionTestResult,
  ModelProviderId
} from '../../../../shared/contracts'

/**
 * Language Engine settings. Three real providers, each with its own
 * fields, honoring the user-supplied model name, and a real connection
 * test that runs through the main process.
 */
export function LanguageEngineSection({
  config,
  onRefresh
}: {
  config: AppConfigView
  onRefresh: () => Promise<void>
}) {
  const m = config.model
  const [providerDraft, setProviderDraft] = useState<ModelProviderId | ''>(
    (m.provider.value as ModelProviderId) ?? ''
  )
  const [modelIdDraft, setModelIdDraft] = useState(m.modelId.value)
  const [googleKeyDraft, setGoogleKeyDraft] = useState('')
  const [openrouterKeyDraft, setOpenrouterKeyDraft] = useState('')
  const [ollamaKeyDraft, setOllamaKeyDraft] = useState('')
  const [ollamaBaseDraft, setOllamaBaseDraft] = useState(
    m.ollamaBaseUrl.source === 'default' ? '' : m.ollamaBaseUrl.value
  )
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [testing, setTesting] = useState(false)
  const [liveResult, setLiveResult] = useState<ConnectionTestResult | null>(null)

  const status = modelStatus(config, testing)
  const lastTest = config.tests.model

  /** The provider shown in the UI: draft when being changed, else effective. */
  const selected = touched['provider'] && providerDraft ? providerDraft : ((m.provider.value as ModelProviderId) ?? '')

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const result = await getApi().saveModelSettings({
        provider: touched['provider'] && providerDraft ? providerDraft : undefined,
        modelId: touched['modelId'] ? modelIdDraft : undefined,
        googleApiKey: touched['googleKey'] && googleKeyDraft.trim() !== '' ? googleKeyDraft : undefined,
        openrouterApiKey: touched['openrouterKey'] && openrouterKeyDraft.trim() !== '' ? openrouterKeyDraft : undefined,
        ollamaApiKey: touched['ollamaKey'] && ollamaKeyDraft.trim() !== '' ? ollamaKeyDraft : undefined,
        ollamaBaseUrl: touched['ollamaBase'] ? ollamaBaseDraft : undefined
      })
      if (!result.ok) {
        setErrors(result.errors)
      } else {
        setSavedFlash(true)
        window.setTimeout(() => setSavedFlash(false), 1800)
        setTouched({})
        setGoogleKeyDraft('')
        setOpenrouterKeyDraft('')
        setOllamaKeyDraft('')
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
      const result = (await getApi().testConnection('model')) as ConnectionTestResult
      setLiveResult(result)
      await onRefresh()
    } finally {
      setTesting(false)
    }
  }

  return (
    <SectionCard title="Language engine">
      <div className="flex flex-col gap-5">
        <p className="max-w-[600px] text-[12px] leading-relaxed text-[#8b8c95]">
          Connect one language engine. The exact model name always comes from you — Flowloom never
          picks a model and never switches providers to make a test pass.
        </p>

        <EffectiveLine
          entity="Effective provider"
          value={m.provider.value || '—'}
          source={m.provider.source}
          extra={
            m.modelId.value
              ? { label: 'model', value: m.modelId.value, mono: true }
              : undefined
          }
        />

        {/* provider selection */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PROVIDER_OPTIONS.map((option) => {
            const active = selected === option.id
            const runningFromEnv = m.provider.source === 'env' && m.provider.value === option.id
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setProviderDraft(option.id)
                  setTouched((t) => ({ ...t, provider: true }))
                }}
                aria-pressed={active}
                className={cn(
                  'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-100',
                  active ? 'border-[#3f4cc0] bg-[#eef0fb]' : 'border-[#e6e6ea] bg-white hover:border-[#c9cad3]'
                )}
              >
                <span className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-[#1c1d21]">{option.name}</span>
                  {active ? <CircleCheckIcon size={14} strokeWidth={2.2} className="text-[#3f4cc0]" /> : null}
                </span>
                <span className="text-[11px] leading-relaxed text-[#8b8c95]">{option.blurb}</span>
                {runningFromEnv && !active ? (
                  <span className="text-[10.5px] font-medium text-[#6f707a]">Effective from .env</span>
                ) : null}
              </button>
            )
          })}
        </div>

        {/* provider fields */}
        {selected === 'google' ? (
          <GoogleFields
            config={config}
            errors={errors}
            markTouched={(k) => setTouched((t) => ({ ...t, [k]: true }))}
            keyDraft={googleKeyDraft}
            setKeyDraft={setGoogleKeyDraft}
            modelIdDraft={modelIdDraft}
            setModelIdDraft={setModelIdDraft}
            onRefresh={onRefresh}
          />
        ) : null}
        {selected === 'openrouter' ? (
          <OpenRouterFields
            config={config}
            errors={errors}
            markTouched={(k) => setTouched((t) => ({ ...t, [k]: true }))}
            keyDraft={openrouterKeyDraft}
            setKeyDraft={setOpenrouterKeyDraft}
            modelIdDraft={modelIdDraft}
            setModelIdDraft={setModelIdDraft}
            onRefresh={onRefresh}
          />
        ) : null}
        {selected === 'ollama' ? (
          <OllamaFields
            config={config}
            errors={errors}
            markTouched={(k) => setTouched((t) => ({ ...t, [k]: true }))}
            keyDraft={ollamaKeyDraft}
            setKeyDraft={setOllamaKeyDraft}
            baseDraft={ollamaBaseDraft}
            setBaseDraft={setOllamaBaseDraft}
            modelIdDraft={modelIdDraft}
            setModelIdDraft={setModelIdDraft}
            onRefresh={onRefresh}
          />
        ) : null}

        {/* save + test */}
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
            disabled={status.status === 'unconfigured' && status.missing.length > 0}
            onClick={() => void runTest()}
            title={
              status.missing.length > 0
                ? 'Complete the missing fields and save first'
                : 'Runs a real, minimal request against the configured provider'
            }
          >
            Test connection
          </Button>
        </div>

        <StatusChip status={status.status} missing={status.missing} />

        <TestOutcome test={liveResult ?? lastTest ?? null} />
      </div>
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/* Field groups                                                        */
/* ------------------------------------------------------------------ */

type MarkTouched = (key: string) => void
type Refresh = () => Promise<void>

interface GroupProps {
  config: AppConfigView
  errors: Record<string, string>
  markTouched: MarkTouched
  keyDraft: string
  setKeyDraft: (value: string) => void
  modelIdDraft: string
  setModelIdDraft: (value: string) => void
  onRefresh: Refresh
  /** Only used by the Ollama field group. */
  baseDraft?: string
  setBaseDraft?: (value: string) => void
}

function clearAndRefresh(key: ClearOverrideKey, refresh: Refresh): () => void {
  return () => {
    void (async () => {
      await getApi().clearOverride(key)
      await refresh()
    })()
  }
}

function GoogleFields({ config, errors, markTouched, keyDraft, setKeyDraft, modelIdDraft, setModelIdDraft, onRefresh }: GroupProps) {
  const key = config.model.googleApiKey
  const model = config.model.modelId
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        label="Google API key"
        description="From Google AI Studio. Stored protected by your system's secure credential storage."
        error={errors['googleApiKey']}
        source={key.configured ? key.source : undefined}
        onClearOverride={key.source === 'settings' || key.source === 'session' ? clearAndRefresh('model.googleApiKey', onRefresh) : null}
      >
        <SecretInput
          value={keyDraft}
          onChange={(event) => {
            setKeyDraft(event.target.value)
            markTouched('googleKey')
          }}
          placeholder={key.configured ? 'Saved — type to replace' : 'Paste an API key from Google AI Studio'}
          invalid={Boolean(errors['googleApiKey'])}
        />
      </Field>
      <Field
        label="Model name"
        description="Exactly as Google supplies it — for example the Gemma model ID you intend to use."
        error={errors['modelId']}
        source={model.source}
        onClearOverride={model.source === 'settings' ? clearAndRefresh('model.modelId', onRefresh) : null}
      >
        <TextInput
          value={modelIdDraft}
          onChange={(event) => {
            setModelIdDraft(event.target.value)
            markTouched('modelId')
          }}
          placeholder={model.source === 'unset' ? 'Enter the model name supplied by your provider' : 'Editing replaces the saved override'}
          spellCheck={false}
        />
      </Field>
    </div>
  )
}

function OpenRouterFields({ config, errors, markTouched, keyDraft, setKeyDraft, modelIdDraft, setModelIdDraft, onRefresh }: GroupProps) {
  const key = config.model.openrouterApiKey
  const model = config.model.modelId
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        label="OpenRouter API key"
        error={errors['openrouterApiKey']}
        source={key.configured ? key.source : undefined}
        onClearOverride={key.source === 'settings' || key.source === 'session' ? clearAndRefresh('model.openrouterApiKey', onRefresh) : null}
      >
        <SecretInput
          value={keyDraft}
          onChange={(event) => {
            setKeyDraft(event.target.value)
            markTouched('openrouterKey')
          }}
          placeholder={key.configured ? 'Saved — type to replace' : 'Paste an OpenRouter API key'}
          invalid={Boolean(errors['openrouterApiKey'])}
        />
      </Field>
      <Field
        label="Model name"
        description="Vendor-qualified exactly as OpenRouter supplies it, e.g. a Gemma model under google/…"
        error={errors['modelId']}
        source={model.source}
        onClearOverride={model.source === 'settings' ? clearAndRefresh('model.modelId', onRefresh) : null}
      >
        <TextInput
          value={modelIdDraft}
          onChange={(event) => {
            setModelIdDraft(event.target.value)
            markTouched('modelId')
          }}
          placeholder={model.source === 'unset' ? 'Enter the model name supplied by your provider' : 'Editing replaces the saved override'}
          spellCheck={false}
        />
      </Field>
    </div>
  )
}

function OllamaFields({ config, errors, markTouched, keyDraft, setKeyDraft, baseDraft, setBaseDraft, modelIdDraft, setModelIdDraft, onRefresh }: GroupProps) {
  const key = config.model.ollamaApiKey
  const model = config.model.modelId
  const base = config.model.ollamaBaseUrl
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        label="Server URL"
        description="Address of your running Ollama server. Leave empty to use the default http://127.0.0.1:11434."
        error={errors['ollamaBaseUrl']}
        source={base.source}
        onClearOverride={base.source === 'settings' ? clearAndRefresh('model.ollamaBaseUrl', onRefresh) : null}
      >
        <TextInput
          value={baseDraft}
          onChange={(event) => {
            setBaseDraft?.(event.target.value)
            markTouched('ollamaBase')
          }}
          placeholder={base.source === 'default' ? 'http://127.0.0.1:11434 (default)' : 'Editing replaces the saved override'}
          spellCheck={false}
        />
      </Field>
      <Field
        label="Model name (as installed)"
        description="Exactly as installed on the server — check with “ollama list”. Example shape: gemma3:4b."
        error={errors['modelId']}
        source={model.source}
        onClearOverride={model.source === 'settings' ? clearAndRefresh('model.modelId', onRefresh) : null}
      >
        <TextInput
          value={modelIdDraft}
          onChange={(event) => {
            setModelIdDraft(event.target.value)
            markTouched('modelId')
          }}
          placeholder={model.source === 'unset' ? 'Enter the model name exactly as installed' : 'Editing replaces the saved override'}
          spellCheck={false}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field
          label={
            <span>
              Server API key <OptionalTag>only if your endpoint requires authentication</OptionalTag>
            </span>
          }
          error={errors['ollamaApiKey']}
          source={key.configured ? key.source : undefined}
          onClearOverride={key.source === 'settings' || key.source === 'session' ? clearAndRefresh('model.ollamaApiKey', onRefresh) : null}
        >
          <SecretInput
            value={keyDraft}
            onChange={(event) => {
              setKeyDraft(event.target.value)
              markTouched('ollamaKey')
            }}
            placeholder={key.configured ? 'Saved — type to replace' : 'Leave empty when the server needs no auth'}
            invalid={Boolean(errors['ollamaApiKey'])}
          />
        </Field>
      </div>
    </div>
  )
}

