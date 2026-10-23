import { useEffect, useState } from 'react'
import { Trash2 as TrashIcon, X as CloseIcon } from 'lucide-react'
import type { NodeTypeId } from '../../../../shared/nodeSchema'
import { getNodeType, PAPER_REASONING_EFFORTS } from '../../../../shared/nodeSchema'
import { cn } from '../../lib/cn'
import { Field } from '../ui/Field'
import { TextInput, TextArea, SelectInput } from '../ui/TextInput'
import { Button, IconButton } from '../ui/Button'
import type { FlowNode } from './nodeTypes'

/**
 * The contextual inspector for the selected node. Fields adapt to the
 * node's registered type; validation comes from the shared node schema
 * so the inspector, node cards, and main-process persistence agree.
 * Changes update the canvas immediately and persist through the
 * workflow store (debounced in the page, not here).
 */
export function NodeInspector({
  node,
  onConfigChange,
  onDelete,
  onClose
}: {
  node: FlowNode
  onConfigChange: (patch: Record<string, unknown>) => void
  onDelete: (nodeId: string) => void
  onClose: () => void
}) {
  const typeId = node.data.typeId as NodeTypeId
  const definition = getNodeType(typeId)
  const config = node.data.config
  const errors = definition.validateConfig(config)
  const missing = definition.requiredFields(config)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    setConfirming(false)
  }, [node.id])

  const closeHeader = (
    <div className="flex items-center justify-between border-b border-[#f0f0f3] px-3 py-2">
      <p className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[#a2a3ac]">
        {definition.label}
      </p>
      <IconButton
        label="Close the inspector (Escape)"
        className="h-6 w-6"
        onClick={onClose}
      >
        <CloseIcon size={13} strokeWidth={2} />
      </IconButton>
    </div>
  )

  return (
    <aside
      aria-label={`${definition.label} configuration`}
      className="absolute right-3 top-3 bottom-3 z-20 flex w-[264px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-[#e3e4e8] bg-white shadow-[0_8px_28px_rgba(20,20,24,0.12)]"
    >
      {closeHeader}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {typeId === 'browserAction' ? <BrowserFields config={config} errors={errors} onChange={onConfigChange} /> : null}
        {typeId === 'paperInstruments' ? <PaperFields config={config} errors={errors} onChange={onConfigChange} /> : null}
        {typeId === 'delay' ? <DelayFields config={config} errors={errors} onChange={onConfigChange} /> : null}
        {typeId === 'condition' ? <ConditionFields config={config} errors={errors} onChange={onConfigChange} /> : null}
        {typeId === 'data' ? <DataFields config={config} errors={errors} onChange={onConfigChange} /> : null}
        {typeId === 'join' ? <JoinFields config={config} errors={errors} onChange={onConfigChange} /> : null}
        {typeId === 'trigger' ? (
          <TextInput
            value="manual"
            readOnly
            aria-label="Trigger mode"
            className="font-mono text-xs text-[#8b8c95]"
          />
        ) : null}

        {missing.length > 0 ? (
          <p className="mt-3 rounded-lg border border-[#f0e5cf] bg-[#fbf6ec] px-2.5 py-2 text-[11.5px] leading-relaxed text-[#7a5a24]">
            This step still needs {missing.length === 1 ? 'a detail' : `${missing.length} details`} before
            it could run — the workflow can be saved meanwhile.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between border-t border-[#f0f0f3] px-3 py-2">
        {confirming ? (
          <>
            <span className="text-[11px] text-[#c22f3d]">Remove this step?</span>
            <div className="flex items-center gap-1.5">
              <Button variant="danger-ghost" size="sm" onClick={() => onDelete(node.id)}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="truncate text-[10.5px] text-[#a2a3ac]">id {node.id}</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              <TrashIcon size={12.5} strokeWidth={2} />
              Remove
            </Button>
          </>
        )}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Typed field groups                                                  */
/* ------------------------------------------------------------------ */

const ACTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'navigate', label: 'Navigate to a URL' },
  { value: 'extractText', label: 'Extract text from an element' },
  { value: 'extractPageText', label: 'Extract the page text' },
  { value: 'click', label: 'Click an element' },
  { value: 'fillField', label: 'Fill a form field' },
  { value: 'waitFor', label: 'Wait for an element' },
  { value: 'pageInfo', label: 'Read the page URL and title' },
  { value: 'screenshot', label: 'Capture a screenshot' }
]

function selectValue(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key]
  return typeof value === 'string' && value !== '' ? value : fallback
}

function stringField(config: Record<string, unknown>, key: string, fallback = ''): string {
  const value = config[key]
  return typeof value === 'string' ? value : fallback
}

function SelectField({
  label,
  value,
  options,
  onChange,
  invalid
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  invalid?: boolean
}) {
  return (
    <Field label={label} error={invalid ? 'Select an option.' : undefined}>
      <SelectInput
        value={value}
        aria-label={label}
        invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectInput>
    </Field>
  )
}

function BrowserFields({
  config,
  errors,
  onChange
}: {
  config: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const action = selectValue(config, 'action', 'navigate')
  const needsSelector = action === 'extractText' || action === 'click' || action === 'fillField' || action === 'waitFor'
  // Every browser action runs in its own fresh session, so each one can
  // aim itself at a page: `navigate` requires the URL, the rest accept
  // it as an optional "go here first".
  const needsUrl = true
  const urlRequired = action === 'navigate'
  const needsValue = action === 'fillField'
  const needsLimit = action === 'extractText' || action === 'extractPageText'
  const timeoutRaw = typeof config['timeoutSeconds'] === 'number' ? String(config['timeoutSeconds']) : '30'
  const limitRaw = typeof config['limit'] === 'number' ? String(config['limit']) : '2000'
  const numberError = (key: 'timeoutSeconds' | 'limit'): string | undefined => {
    const raw = key === 'timeoutSeconds' ? timeoutRaw : limitRaw
    return errors[key] ?? (Number.isFinite(Number(raw)) ? undefined : `Enter the ${key === 'timeoutSeconds' ? 'timeout in seconds' : 'limit in characters'}.`)
  }
  const applyNumber = (key: 'timeoutSeconds' | 'limit') => (raw: string) => {
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return // keep the last committed value until a whole number is typed
    }
    onChange({ [key]: parsed })
  }
  return (
    <div className="flex flex-col gap-3.5">
      <Field label="Step name" error={errors['name']}>
        <TextInput
          value={stringField(config, 'name')}
          placeholder="e.g. Open the issues page"
          aria-label="Step name"
          invalid={Boolean(errors['name'])}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>
      <SelectField
        label="Action"
        value={action}
        options={ACTION_OPTIONS}
        onChange={(value) => onChange({ action: value })}
      />
      {needsUrl ? (
        <Field
          label={urlRequired ? 'URL' : 'URL (optional — navigate first)'}
          description={urlRequired ? undefined : 'The page the action should visit before it runs. Leave empty for the browser default page.'}
          error={errors['url']}
        >
          <TextInput
            value={stringField(config, 'url')}
            placeholder={urlRequired ? 'https://…' : 'https://… (optional)'}
            inputMode="url"
            aria-label="Destination URL"
            invalid={Boolean(errors['url'])}
            onChange={(event) => onChange({ url: event.target.value })}
          />
        </Field>
      ) : null}
      {needsSelector ? (
        <Field
          label="Element selector"
          description="How the step finds the element — for example #search-input or button.main"
          error={errors['selector']}
        >
          <TextInput
            value={stringField(config, 'selector')}
            placeholder="#search-input"
            aria-label="Element selector"
            invalid={Boolean(errors['selector'])}
            onChange={(event) => onChange({ selector: event.target.value })}
          />
        </Field>
      ) : null}
      {needsValue ? (
        <Field label="Text to type" error={errors['value']}>
          <TextInput
            value={stringField(config, 'value')}
            placeholder="The text this step enters"
            aria-label="Text to fill the field with"
            invalid={Boolean(errors['value'])}
            onChange={(event) => onChange({ value: event.target.value })}
          />
        </Field>
      ) : null}
      {action === 'screenshot' ? (
        <label className="flex items-center gap-2 text-[12px] text-[#5d5e66]">
          <input
            type="checkbox"
            checked={config['fullPage'] === true}
            aria-label="Capture the full page"
            onChange={(event) => onChange({ fullPage: event.target.checked })}
            className="h-4 w-4 accent-[#3f4cc0]"
          />
          Capture the full scrollable page
        </label>
      ) : null}
      {needsLimit ? (
        <Field
          label="Extraction limit"
          description="Maximum characters kept from the page."
          error={numberError('limit')}
        >
          <div className="relative">
            <TextInput
              type="number"
              min={20}
              max={20000}
              step={1}
              value={limitRaw}
              aria-label="Extraction limit in characters"
              invalid={Boolean(numberError('limit'))}
              onChange={(event) => applyNumber('limit')(event.target.value)}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#a2a3ac]">
              chars
            </span>
          </div>
        </Field>
      ) : null}
      {needsSelector || needsUrl || needsValue ? (
        <Field
          label="Timeout"
          description="How long the step waits for navigation or the element (5–120 seconds)."
          error={numberError('timeoutSeconds')}
        >
          <div className="relative">
            <TextInput
              type="number"
              min={5}
              max={120}
              step={1}
              value={timeoutRaw}
              aria-label="Timeout in seconds"
              invalid={Boolean(numberError('timeoutSeconds'))}
              onChange={(event) => applyNumber('timeoutSeconds')(event.target.value)}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#a2a3ac]">
              sec
            </span>
          </div>
        </Field>
      ) : null}
      {needsSelector || needsValue ? (
        <Field label="Use a previous step's output" description="Optional">
          <p className="text-[11px] leading-relaxed text-[#8b8c95]">
            Text fields accept <span className="font-mono text-[#3f4cc0]">{'{{stepId}}'}</span> references to
            a finished step's output — for example a URL built by a Text value step.
          </p>
        </Field>
      ) : null}
      <p className="text-[11px] leading-relaxed text-[#8b8c95]">
        This step runs in a real headless browser through Browserbase when you press Run — each execution
        creates one short-lived session that Flowloom closes afterwards. Exit code honesty applies:
        a step that never completes is reported as failed, never as an empty success.
      </p>
    </div>
  )
}

/**
 * Paper Instruments fields. Every value is bounded to match the shared
 * schema; the model field is optional and falls back to the model
 * configured in Settings (never substituted silently by Flowloom).
 */
function PaperFields({
  config,
  errors,
  onChange
}: {
  config: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const effortOptions = PAPER_REASONING_EFFORTS.map((value) => ({
    value,
    label: value === 'low' ? 'Low (default, smallest cost)' : value === 'high' ? 'High' : 'Max (highest cost)'
  }))
  const tokensRaw = typeof config['maxOutputTokens'] === 'number' ? String(config['maxOutputTokens']) : '512'
  const timeoutRaw = typeof config['timeoutSeconds'] === 'number' ? String(config['timeoutSeconds']) : '60'
  const numberError = (key: 'maxOutputTokens' | 'timeoutSeconds', raw: string, range: string): string | undefined =>
    errors[key] ?? (Number.isFinite(Number(raw)) ? undefined : range)
  const applyNumber = (key: 'maxOutputTokens' | 'timeoutSeconds') => (raw: string) => {
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return // keep the last committed value until a whole number is typed
    }
    onChange({ [key]: parsed })
  }
  return (
    <div className="flex flex-col gap-3.5">
      <Field label="Step name" error={errors['name']}>
        <TextInput
          value={stringField(config, 'name')}
          placeholder="e.g. Summarize the page"
          aria-label="Step name"
          invalid={Boolean(errors['name'])}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>
      <Field label="Prompt" description="What to send as the user turn. Accepts {{stepId}} references." error={errors['prompt']}>
        <TextArea
          value={stringField(config, 'prompt')}
          rows={5}
          placeholder="e.g. Summarize this page in three sentences: {{abc123}}"
          aria-label="Prompt"
          invalid={Boolean(errors['prompt'])}
          onChange={(event) => onChange({ prompt: event.target.value })}
        />
      </Field>
      <Field
        label="System instruction (optional)"
        description="Sets how the model answers. Accepts {{stepId}} references."
        error={errors['system']}
      >
        <TextArea
          value={stringField(config, 'system')}
          rows={3}
          placeholder="e.g. Reply only with the JSON object."
          aria-label="System instruction"
          invalid={Boolean(errors['system'])}
          onChange={(event) => onChange({ system: event.target.value })}
        />
      </Field>
      <Field
        label="Model (optional)"
        description="Leave empty to use the Paper Instruments model configured in Settings. Use a model id the provider lists at /v1/models."
        error={errors['model']}
      >
        <TextInput
          value={stringField(config, 'model')}
          placeholder="Uses the Settings model"
          aria-label="Model id"
          invalid={Boolean(errors['model'])}
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </Field>
      <SelectField
        label="Reasoning effort"
        value={selectValue(config, 'reasoningEffort', 'low')}
        options={effortOptions}
        onChange={(value) => onChange({ reasoningEffort: value })}
      />
      <Field
        label="Output limit"
        description="Maximum tokens for this reply, reasoning included (64–8,192)."
        error={numberError('maxOutputTokens', tokensRaw, 'Enter the token limit.')}
      >
        <div className="relative">
          <TextInput
            type="number"
            min={64}
            max={8192}
            step={1}
            value={tokensRaw}
            aria-label="Output limit in tokens"
            invalid={Boolean(errors['maxOutputTokens']) || !Number.isFinite(Number(tokensRaw))}
            onChange={(event) => applyNumber('maxOutputTokens')(event.target.value)}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#a2a3ac]">
            tokens
          </span>
        </div>
      </Field>
      <Field
        label="Structured output (optional)"
        description='A JSON Schema object for a JSON reply, e.g. {"type":"object","properties":{"summary":{"type":"string"}},"additionalProperties":false}. Flowloom checks a documented subset of the schema.'
        error={errors['responseSchema']}
      >
        <TextArea
          value={stringField(config, 'responseSchema')}
          rows={4}
          placeholder='{"type":"object","properties":{…}}'
          aria-label="Structured output JSON schema"
          invalid={Boolean(errors['responseSchema'])}
          base="min-h-[72px] w-full resize-y rounded-[10px] px-3 py-2 font-mono text-[11.5px]"
          onChange={(event) => onChange({ responseSchema: event.target.value })}
        />
      </Field>
      <Field
        label="Timeout"
        description="How long one generation may take (5–120 seconds)."
        error={numberError('timeoutSeconds', timeoutRaw, 'Enter the timeout in seconds.')}
      >
        <div className="relative">
          <TextInput
            type="number"
            min={5}
            max={120}
            step={1}
            value={timeoutRaw}
            aria-label="Timeout in seconds"
            invalid={Boolean(errors['timeoutSeconds']) || !Number.isFinite(Number(timeoutRaw))}
            onChange={(event) => applyNumber('timeoutSeconds')(event.target.value)}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#a2a3ac]">
            sec
          </span>
        </div>
      </Field>
      <p className="text-[11px] leading-relaxed text-[#8b8c95]">
        This step bills real prepaid credit at Paper Instruments each time it runs. The step refuses
        when the configured minimum prepaid balance cannot be confirmed, and token counts recorded
        in history come from the provider's usage report.
      </p>
    </div>
  )
}

function DelayFields({
  config,
  errors,
  onChange
}: {
  config: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const committed = typeof config['seconds'] === 'number' ? String(config['seconds']) : ''
  const [draft, setDraft] = useState(committed)

  useEffect(() => {
    setDraft(typeof config['seconds'] === 'number' ? String(config['seconds']) : '')
    // Re-sync only when the committed value itself changes.
  }, [typeof config['seconds'] === 'number' ? config['seconds'] : null])

  const apply = (raw: string) => {
    setDraft(raw)
    if (raw.trim() === '') return // keep last valid value until a number is typed
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) onChange({ seconds: parsed })
  }
  const revert = () => setDraft(committed)

  return (
    <div className="flex flex-col gap-3.5">
      <Field
        label="Wait time"
        description="Between 1 second and 1 hour. Actual waiting happens when the execution phase runs."
        error={errors['seconds'] ?? (isDraftInvalid(draft) ? 'Enter the number of seconds to wait.' : undefined)}
      >
        <div className="relative">
          <TextInput
            type="number"
            min={1}
            max={3600}
            step={1}
            value={draft}
            placeholder="30"
            aria-label="Delay in seconds"
            invalid={Boolean(errors['seconds']) || isDraftInvalid(draft)}
            onChange={(event) => apply(event.target.value)}
            onBlur={() => invalidDraftRevert(draft, committed, revert)}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#a2a3ac]">
            sec
          </span>
        </div>
      </Field>
    </div>
  )
}

function isDraftInvalid(draft: string): boolean {
  return draft.trim() !== '' && !Number.isFinite(Number(draft))
}

function invalidDraftRevert(draft: string, committed: string, revert: () => void): void {
  if (draft.trim() === '' || isDraftInvalid(draft)) revert()
}

function ConditionFields({
  config,
  errors,
  onChange
}: {
  config: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <Field
        label="Text to check"
        description="The value arriving from the previous step that this condition inspects."
        error={errors['checkText']}
      >
        <TextInput
          value={stringField(config, 'checkText')}
          placeholder="e.g. the page status text"
          aria-label="Text to check"
          invalid={Boolean(errors['checkText'])}
          onChange={(event) => onChange({ checkText: event.target.value })}
        />
      </Field>
      <Field label="Contains" error={errors['contains']}>
        <TextInput
          value={stringField(config, 'contains')}
          placeholder="e.g. success"
          aria-label="Value the text must contain"
          invalid={Boolean(errors['contains'])}
          onChange={(event) => onChange({ contains: event.target.value })}
        />
      </Field>
      <p className="text-[11px] leading-relaxed text-[#8b8c95]">
        Two paths leave this step: <span className="font-medium text-[#5d5e66]">Matches</span> and{' '}
        <span className="font-medium text-[#5d5e66]">Otherwise</span>. Connect one or both.
      </p>
    </div>
  )
}

function DataFields({
  config,
  errors,
  onChange
}: {
  config: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const text = stringField(config, 'value')
  return (
    <div className="flex flex-col gap-3.5">
      <Field label="Text value" error={errors['value']}>
        <TextArea
          value={text}
          rows={4}
          placeholder="Text or a small structured value this step holds"
          aria-label="Text value"
          invalid={Boolean(errors['value'])}
          onChange={(event) => onChange({ value: event.target.value })}
        />
      </Field>
      <p className="text-[11px] leading-relaxed text-[#8b8c95]">
        Stored with the workflow and passed to the next step when execution arrives. Nothing is
        processed remotely in this phase.
      </p>
    </div>
  )
}

function JoinFields({
  config,
  onChange
}: {
  config: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const behavior = selectValue(config, 'behavior', 'all')
  const options: Array<{ value: 'all' | 'any'; title: string; body: string }> = [
    { value: 'all', title: 'Wait for all branches', body: 'Continue once every incoming connection has arrived.' },
    { value: 'any', title: 'First branch wins', body: 'Continue as soon as any incoming connection arrives.' }
  ]
  return (
    <div className="flex flex-col gap-2">
      {options.map((option) => {
        const active = behavior === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange({ behavior: option.value })}
            className={cn(
              'rounded-xl border px-3 py-2.5 text-left transition-colors duration-100',
              active
                ? 'border-[#3f4cc0] ring-[3px] ring-[#3f4cc0]/15'
                : 'border-[#e3e4e8] hover:border-[#cbccd3]'
            )}
          >
            <span className="block text-[12.5px] font-medium text-[#1c1d21]">{option.title}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-[#8b8c95]">{option.body}</span>
          </button>
        )
      })}
      <p className="mt-1 text-[11px] leading-relaxed text-[#8b8c95]">
        The join coordinates branches when the execution phase runs; it is saved with the workflow now.
      </p>
    </div>
  )
}
