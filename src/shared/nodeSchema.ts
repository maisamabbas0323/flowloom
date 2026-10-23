import { z } from 'zod'

/**
 * The typed workflow data model and the node registry, shared by the
 * renderer (editor + inspector), the main process (persistence +
 * validation authority), and the tests.
 *
 * Version 1 ships the editor with these node types:
 * trigger, browser action, delay, condition, data, and join. Execution
 * behavior is deliberately NOT part of this module — phase 3 attaches
 * an execution engine to the same registry.
 */

export const WORKFLOW_SCHEMA_VERSION = 1

export type NodeTypeId = 'trigger' | 'browserAction' | 'delay' | 'condition' | 'data' | 'join' | 'paperInstruments'

export const NODE_TYPE_IDS: readonly NodeTypeId[] = [
  'trigger',
  'browserAction',
  'paperInstruments',
  'delay',
  'condition',
  'data',
  'join'
]

export function isNodeTypeId(value: string): value is NodeTypeId {
  return (NODE_TYPE_IDS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ */
/* Graph primitives                                                    */
/* ------------------------------------------------------------------ */

export interface WorkflowNode {
  id: string
  type: NodeTypeId
  position: { x: number; y: number }
  config: Record<string, unknown>
}

export interface WorkflowEdge {
  id: string
  source: string
  /** Output handle id on the source node ('out', or 'true'/'false'). */
  sourceHandle?: string
  target: string
}

/** The versioned graph payload persisted inside a WorkflowRecord. */
export interface WorkflowGraph {
  schemaVersion: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/* ------------------------------------------------------------------ */
/* Per-type configuration schemas                                      */
/* ------------------------------------------------------------------ */

export const triggerConfigSchema = z.strictObject({ kind: z.literal('manual') })
export type TriggerConfig = z.infer<typeof triggerConfigSchema>

export const BROWSER_ACTIONS = [
  'navigate',
  'extractText',
  'extractPageText',
  'click',
  'fillField',
  'waitFor',
  'pageInfo',
  'screenshot'
] as const

export type BrowserActionKind = (typeof BROWSER_ACTIONS)[number]

export const browserActionConfigSchema = z.strictObject({
  // An empty name/url is an *incomplete* step (reported as a config
  // issue, and the node is flagged in the editor) — not a structural
  // failure, so half-built workflows can still be saved.
  name: z.string().max(80, 'Keep the step name under 80 characters.'),
  action: z.enum(BROWSER_ACTIONS),
  url: z
    .string()
    .trim()
    .refine((v) => v === '' || isHttpUrl(v), 'Enter a full URL starting with http:// or https://.')
    .optional(),
  selector: z.string().trim().max(300).optional(),
  value: z.string().max(4000).optional(),
  /** Per-operation wait bound (selector waits, navigation). */
  timeoutSeconds: z
    .number()
    .finite()
    .int('Use whole seconds.')
    .min(5, 'The timeout must be at least 5 seconds.')
    .max(120, 'Keep the timeout under two minutes.')
    .optional()
    .default(30),
  /** Upper bound for extracted text, in characters. */
  limit: z
    .number()
    .finite()
    .int('Use whole characters.')
    .min(20, 'The extraction limit must be at least 20 characters.')
    .max(20000, 'Keep the extraction limit under 20,000 characters.')
    .optional()
    .default(2000),
  /** Full-page capture for the screenshot action. */
  fullPage: z.boolean().optional()
})
export type BrowserActionConfig = z.infer<typeof browserActionConfigSchema>

/**
 * URL safety for browser navigation: only http(s), no loopback,
 * private-network, link-local, or cloud-metadata destinations by default.
 * Parsed, not string-prefixed — an IP literal or a `user:pass@` tricked
 * into `http://https://evil.com` cannot slip through.
 */
const PRIVATE_HOST_RE = /^(localhost|.*\.localhost|.*\.local|metadata|metadata\.google|metadata\.google\.internal)$/i

export interface UrlCheckResult {
  ok: true
  url: string
}

export interface UrlCheckFailure {
  ok: false
  error: string
}

/** Returns true for any private/loopback/link-local/metadata target. */
export function isPrivateOrInternalHost(host: string): boolean {
  if (host.includes(':')) {
    const [address, _] = host.split(':')
    if (address.match(/^\d+$/)) return isPrivateIpAddress(address)
  }
  if (PRIVATE_HOST_RE.test(host)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpAddress(host)
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1)
    // Enclosed IPv6 (or IPv4-mapped) literal.
    if (inner.includes('.')) {
      const tail = inner.split(':').pop() ?? ''
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateIpAddress(tail)
    }
    return /^[fF][eE]/.test(inner) || inner.startsWith('::1') || inner.startsWith('fc') || inner.startsWith('fd')
  }
  return false
}

function isPrivateIpAddress(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false // not a valid IPv4 literal — treat as uncertain, allow DNS
  }
  const [a, b] = [parts[0], parts[1]]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * Validates a user-provided navigation target. The checks cover schemes
 * and destination hosts; the remote browser's own network boundary is
 * Browserbase's, so DNS-level SSRF protection is best-effort (documented
 * limitation, never claimed as complete).
 */
export function checkNavigationUrl(raw: string): UrlCheckResult | UrlCheckFailure {
  const value = raw.trim()
  if (value === '') return { ok: false, error: 'The URL is empty.' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: 'That is not a valid URL.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Only http:// and https:// URLs can be navigated to — "${parsed.protocol}" is not allowed.` }
  }
  if (!parsed.hostname) return { ok: false, error: 'The URL has no host name.' }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs containing username or password details are not allowed.' }
  }
  if (isPrivateOrInternalHost(parsed.hostname)) {
    return { ok: false, error: 'That address points at a private or internal network destination — only public websites can be used.' }
  }
  if (parsed.port && !/^(80|443|\d{4,5})$/.test(parsed.port)) {
    return { ok: false, error: 'That URL uses an unusual port which is not allowed.' }
  }
  return { ok: true, url: parsed.toString() }
}

/**
 * Paper Instruments generation node (Ultramarine API). The model id is
 * always user-supplied: an empty value uses the model configured in
 * Settings, and the editor shows that instruction instead of guessing.
 */
export const PAPER_REASONING_EFFORTS = ['low', 'high', 'max'] as const
export type PaperReasoningEffort = (typeof PAPER_REASONING_EFFORTS)[number]

export const paperConfigSchema = z.strictObject({
  name: z.string().max(80, 'Keep the step name under 80 characters.'),
  /** Empty = use the model id configured in Settings / .env. */
  model: z.string().trim().max(200).optional().default(''),
  system: z.string().max(4000, 'Keep the system instruction under 4,000 characters.').optional().default(''),
  prompt: z.string().max(20000, 'Keep the prompt under 20,000 characters.'),
  /** Documented values; `low` by default to keep spend small — the docs
   *  recommend `max` for quality and the user can pick it. */
  reasoningEffort: z.enum(PAPER_REASONING_EFFORTS).default('low'),
  /** Output budget in tokens (includes reasoning). Bounded so one step
   *  cannot silently reserve a large prepaid slice. */
  maxOutputTokens: z
    .number()
    .finite()
    .int('Use whole tokens.')
    .min(64, 'The output limit must be at least 64 tokens.')
    .max(8192, 'Keep the output limit under 8,192 tokens.')
    .optional()
    .default(512),
  /** Optional JSON Schema (subset) for a structured `json_object` reply.
   *  Empty = the reply is passed through as plain text. */
  responseSchema: z.string().max(8000, 'Keep the JSON schema under 8,000 characters.').optional().default(''),
  timeoutSeconds: z
    .number()
    .finite()
    .int('Use whole seconds.')
    .min(5, 'The timeout must be at least 5 seconds.')
    .max(120, 'Keep the timeout under two minutes.')
    .optional()
    .default(60)
})
export type PaperInstrumentsConfig = z.infer<typeof paperConfigSchema>

/**
 * Structural sanity for an optional structured-output schema: it must
 * be a JSON object (JSON Schema documents are objects). Deeper
 * constraint checking happens at run time with the supported subset.
 */
export function paperResponseSchemaProblem(config: unknown): string | null {
  const parsed = paperConfigSchema.safeParse(config)
  if (!parsed.success) return null // field errors are surfaced per-field
  const raw = parsed.data.responseSchema ?? ''
  if (raw.trim() === '') return null
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return 'Enter a valid JSON document — the schema is not readable JSON.'
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return 'Enter the schema as a JSON object, for example {"type":"object","properties":{…}}.'
  }
  return null
}

export const delayConfigSchema = z.strictObject({
  seconds: z
    .number()
    .min(1, 'The delay must be at least 1 second.')
    .max(3600, 'Keep delays under one hour — use another trigger to wait longer.')
    .finite()
})
export type DelayConfig = z.infer<typeof delayConfigSchema>

/**
 * Deterministic comparison operators for the condition node. Old saved
 * configs without an operator keep their original meaning via the
 * `contains` default.
 */
export const CONDITION_OPERATORS = [
  'contains',
  'doesNotContain',
  'equals',
  'notEquals',
  'isEmpty',
  'isNotEmpty'
] as const

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

export const conditionConfigSchema = z.strictObject({
  checkText: z.string().max(2000),
  operator: z.enum(CONDITION_OPERATORS).default('contains'),
  contains: z.string().max(2000).optional()
})
export type ConditionConfig = z.infer<typeof conditionConfigSchema>

/** The fields that each condition operator actually needs to evaluate. */
export function conditionRequiredFields(operator: ConditionOperator): Array<'checkText' | 'contains'> {
  if (operator === 'isEmpty' || operator === 'isNotEmpty') return ['checkText']
  return ['checkText', 'contains']
}

export const dataConfigSchema = z.strictObject({
  value: z.string().max(8000).default(''),
  note: z.string().max(200).optional()
})
export type DataConfig = z.infer<typeof dataConfigSchema>

export const joinConfigSchema = z.strictObject({
  behavior: z.enum(['all', 'any'])
})
export type JoinConfig = z.infer<typeof joinConfigSchema>

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export interface NodeHandleSpec {
  id: string
  label: string
}

/**
 * Safe output-reference syntax usable in text fields of executable
 * node configurations: `{{nodeId}}` resolves to the output of that
 * step in the current run. Only identifiers of other nodes match;
 * anything inside the braces other than whitespace + identifier makes
 * the reference invalid rather than being interpreted, and no field
 * is ever evaluated as code.
 */
export const REFERENCE_PATTERN = /\{\{\s*([a-zA-Z0-9_-]{1,64})\s*\}\}/g

/** Returns true when every `{{…}}` token is a well-formed node id. */
export function hasValidReferenceSyntax(raw: string): boolean {
  const withoutValid = raw.replace(REFERENCE_PATTERN, '')
  return !withoutValid.includes('{{')
}

export interface ResolvedTemplate {
  ok: true
  value: string
}

export interface RejectedTemplate {
  ok: false
  error: string
}

/** Consistent output-size ceiling for template resolution. */
export const MAX_TEMPLATE_PAYLOAD = 64_000

/**
 * Resolves `{{nodeId}}` references against outputs published by nodes
 * that have actually finished in this run. Unresolved references are
 * rejected with an actionable message — never silently empty. Payload
 * growth is bounded: resolution past 64 KB is rejected outright.
 */
export function resolveTemplate(
  raw: string,
  outputsByNodeId: Map<string, string>
): ResolvedTemplate | RejectedTemplate {
  let out = ''
  let lastIndex = 0
  const pattern = new RegExp(REFERENCE_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    out += raw.slice(lastIndex, match.index)
    const nodeId = match[1]
    const output = outputsByNodeId.get(nodeId)
    if (output === undefined) {
      const known = [...outputsByNodeId.keys()]
      return {
        ok: false,
        error:
          known.length === 0
            ? `The reference {{${nodeId}}} has no upstream step it could resolve against — connect it through a step that runs earlier.`
            : `The reference {{${nodeId}}} does not match any finished step (finished: ${known.join(', ')}) — check the step id.`
      }
    }
    out += output
    lastIndex = match.index + match[0].length
    if (out.length > MAX_TEMPLATE_PAYLOAD) {
      return {
        ok: false,
        error: `The resolved output would exceed the ${MAX_TEMPLATE_PAYLOAD} character payload limit — check the step's value length.`
      }
    }
  }
  out += raw.slice(lastIndex)
  return { ok: true, value: out }
}

export interface NodeTypeDefinition {
  id: NodeTypeId
  label: string
  /** One-line description for the node library. */
  description: string
  /** Human title shown on the node card for default instances. */
  defaultTitle: string
  acceptsInput: boolean
  outputs: NodeHandleSpec[]
  /**
   * Whether the current execution phase can run this node type.
   * `false` types (browser actions) stop a run at validation with an
   * explicit explanation — they are never silently skipped or faked.
   */
  executable: boolean
  /** Parse + validate a config object; returns field errors keyed by field. */
  validateConfig(config: unknown): Record<string, string>
  /** Coerce a config into its typed shape (defaults applied) or null. */
  parseConfig(config: unknown): Record<string, unknown> | null
  /** Short summary text for the node card. */
  summarize(config: unknown): string
  /** Field names that must be filled before the node is usable. */
  requiredFields(config: unknown): string[]
}

function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_')
    if (!out[key]) out[key] = issue.message
  }
  return out
}

interface RegistryEntry {
  schema: z.ZodType
  meta: Omit<NodeTypeDefinition, 'validateConfig' | 'parseConfig' | 'summarize' | 'requiredFields'>
}

const REGISTRY: Record<NodeTypeId, RegistryEntry> = {
  trigger: {
    schema: triggerConfigSchema,
    meta: {
      id: 'trigger',
      label: 'Trigger',
      description: 'Starts the workflow. Manual runs for now — schedules arrive later.',
      defaultTitle: 'Manual trigger',
      acceptsInput: false,
      executable: true,
      outputs: [{ id: 'out', label: 'Start' }]
    }
  },
  browserAction: {
    schema: browserActionConfigSchema,
    meta: {
      id: 'browserAction',
      label: 'Browser action',
      description: 'Runs a real headless-browser step through Browserbase.',
      defaultTitle: 'Browser step',
      acceptsInput: true,
      executable: true,
      outputs: [{ id: 'out', label: 'Next' }]
    }
  },
  paperInstruments: {
    schema: paperConfigSchema,
    meta: {
      id: 'paperInstruments',
      label: 'Paper Instruments',
      description: 'Sends text to a Paper Instruments model and returns its real reply.',
      defaultTitle: 'Paper Instruments',
      acceptsInput: true,
      executable: true,
      outputs: [{ id: 'out', label: 'Reply' }]
    }
  },
  delay: {
    schema: delayConfigSchema,
    meta: {
      id: 'delay',
      label: 'Delay',
      description: 'Waits a set time before the next step continues.',
      defaultTitle: 'Delay',
      acceptsInput: true,
      executable: true,
      outputs: [{ id: 'out', label: 'Continue' }]
    }
  },
  condition: {
    schema: conditionConfigSchema,
    meta: {
      id: 'condition',
      label: 'Condition',
      description: 'Checks text and branches the flow into two paths.',
      defaultTitle: 'Condition',
      acceptsInput: true,
      executable: true,
      outputs: [
        { id: 'true', label: 'Matches' },
        { id: 'false', label: 'Does not match' }
      ]
    }
  },
  data: {
    schema: dataConfigSchema,
    meta: {
      id: 'data',
      label: 'Data / text',
      description: 'Carries a text value or a small note between steps.',
      defaultTitle: 'Text value',
      acceptsInput: true,
      executable: true,
      outputs: [{ id: 'out', label: 'Out' }]
    }
  },
  join: {
    schema: joinConfigSchema,
    meta: {
      id: 'join',
      label: 'Wait for connections',
      description: 'Runs the next step after branches converge here.',
      defaultTitle: 'Wait for connections',
      acceptsInput: true,
      executable: true,
      outputs: [{ id: 'out', label: 'Out' }]
    }
  }
}

export const DEFAULT_BROWSER_TIMEOUT_SECONDS = 30
export const DEFAULT_BROWSER_LIMIT = 2000

const DEFAULT_CONFIGS: Record<NodeTypeId, Record<string, unknown>> = {
  trigger: { kind: 'manual' },
  browserAction: { name: '', action: 'navigate', url: '' },
  paperInstruments: {
    name: '',
    model: '',
    system: '',
    prompt: '',
    reasoningEffort: 'low',
    maxOutputTokens: 512,
    responseSchema: '',
    timeoutSeconds: 60
  },
  delay: { seconds: 30 },
  condition: { checkText: '', contains: '' },
  data: { value: '' },
  join: { behavior: 'all' }
}

function summarizeBrowserAction(config: BrowserActionConfig): string {
  switch (config.action) {
    case 'navigate':
      return config.url ? config.url : 'No URL yet'
    case 'extractText':
      return config.selector ? `Extract ${config.selector}` : 'Extract — no selector yet'
    case 'extractPageText':
      return config.url ? `Extract the page text from ${config.url}` : 'Extract the visible page text'
    case 'click':
      return config.selector ? `Click ${config.selector}` : 'Click — no selector yet'
    case 'fillField':
      return config.selector && config.value
        ? `Fill ${config.selector}`
        : 'Fill form — finish the details'
    case 'waitFor':
      return config.selector ? `Wait for ${config.selector}` : 'Wait — no selector yet'
    case 'pageInfo':
      return 'Read the page URL and title'
    case 'screenshot':
      return config.fullPage ? 'Capture a full-page screenshot' : 'Capture a screenshot'
  }
}

function summarizePaperInstruments(config: PaperInstrumentsConfig): string {
  const prompt = config.prompt.trim()
  if (prompt === '') return 'No prompt yet'
  const target = config.model !== '' ? config.model : 'the configured model'
  const preview = prompt.length > 36 ? `${prompt.slice(0, 36)}…` : prompt
  const structured = (config.responseSchema ?? '').trim() !== '' ? ' · validated JSON' : ''
  return `"${preview}" → ${target}${structured}`
}

const PAPER_FIELD_MESSAGES: Record<'name' | 'prompt' | 'responseSchema', string> = {
  name: 'Give this step a name.',
  prompt: 'Enter the instruction for this step.',
  responseSchema: 'The JSON schema this step expects back is invalid.'
}

function paperInstrumentsRequired(config: unknown): Array<'name' | 'prompt' | 'responseSchema'> {
  const parsed = paperConfigSchema.safeParse(config)
  if (!parsed.success) return ['name', 'prompt']
  const missing: Array<'name' | 'prompt' | 'responseSchema'> = []
  if (!parsed.data.name.trim()) missing.push('name')
  if (!parsed.data.prompt.trim()) missing.push('prompt')
  if (paperResponseSchemaProblem(config) !== null) missing.push('responseSchema')
  return missing
}

const BROWSER_FIELD_MESSAGES: Record<'name' | 'url' | 'selector' | 'value', string> = {
  name: 'Give this step a name.',
  url: 'Add a URL before configuring this browser step.',
  selector: 'Add the element selector for this action.',
  value: 'Enter the text to fill in.'
}

const REQUIRED_BY_ACTION: Record<BrowserActionConfig['action'], Array<'name' | 'url' | 'selector' | 'value'>> = {
  navigate: ['name', 'url'],
  extractText: ['name', 'selector'],
  extractPageText: ['name'],
  click: ['name', 'selector'],
  fillField: ['name', 'selector', 'value'],
  waitFor: ['name', 'selector'],
  pageInfo: ['name'],
  screenshot: ['name']
}

/** Extra pre-run browser checks that belong to the shared validation. */
export function browserNavigationProblem(config: unknown): string | null {
  const parsed = browserActionConfigSchema.safeParse(config)
  if (!parsed.success || parsed.data.action !== 'navigate') return null
  const raw = parsed.data.url ?? ''
  if (raw === '') return null // incompleteness is reported per-field already
  const check = checkNavigationUrl(raw)
  return check.ok ? null : check.error
}

function browserActionRequired(config: unknown): Array<'name' | 'url' | 'selector' | 'value'> {
  const parsed = browserActionConfigSchema.safeParse(config)
  if (!parsed.success) return ['name']
  const missing: Array<'name' | 'url' | 'selector' | 'value'> = []
  const cfg = parsed.data
  for (const field of REQUIRED_BY_ACTION[cfg.action]) {
    if (field === 'name' && !cfg.name) missing.push('name')
    if (field === 'url' && !cfg.url) missing.push('url')
    if (field === 'selector' && !cfg.selector) missing.push('selector')
    if (field === 'value' && !cfg.value) missing.push('value')
  }
  return missing
}

function validateConfigFor(typeId: NodeTypeId, schema: z.ZodType, config: unknown): Record<string, string> {
  const result = schema.safeParse(config)
  if (!result.success) return zodErrors(result.error)
  if (typeId === 'browserAction') {
    const messages: Record<string, string> = {}
    for (const field of browserActionRequired(config)) {
      messages[field] = BROWSER_FIELD_MESSAGES[field]
    }
    const navigationProblem = browserNavigationProblem(config)
    if (navigationProblem) messages['url'] = navigationProblem
    return messages
  }
  if (typeId === 'paperInstruments') {
    const parsed = paperConfigSchema.safeParse(config)
    if (!parsed.success) return zodErrors(parsed.error)
    const messages: Record<string, string> = {}
    for (const field of paperInstrumentsRequired(config)) {
      messages[field] = PAPER_FIELD_MESSAGES[field]
    }
    const schemaProblem = paperResponseSchemaProblem(config)
    if (schemaProblem) messages['responseSchema'] = schemaProblem
    if (!hasValidReferenceSyntax(parsed.data.system)) {
      messages['system'] = 'Only {{stepId}} references are allowed — check the braces.'
    }
    if (!hasValidReferenceSyntax(parsed.data.prompt)) {
      messages['prompt'] = 'Only {{stepId}} references are allowed — check the braces.'
    }
    return messages
  }
  if (typeId === 'condition') {
    const parsed = conditionConfigSchema.safeParse(config)
    if (!parsed.success) return zodErrors(parsed.error)
    const messages: Record<string, string> = {}
    const needed = conditionRequiredFields(parsed.data.operator)
    if (needed.includes('checkText') && !parsed.data.checkText) {
      messages['checkText'] = 'Enter the text to check.'
    }
    if (needed.includes('contains') && !parsed.data.contains) {
      messages['contains'] = 'Enter the value this compares against.'
    }
    return messages
  }
  return {}
}

export function getNodeType(typeId: string): NodeTypeDefinition {
  if (!isNodeTypeId(typeId)) throw new Error(`Unknown node type: ${String(typeId)}`)
  const entry = REGISTRY[typeId]
  return {
    ...entry.meta,
    validateConfig(config: unknown): Record<string, string> {
      return validateConfigFor(typeId, entry.schema, config)
    },
    parseConfig(config: unknown): Record<string, unknown> | null {
      const result = entry.schema.safeParse(config)
      return result.success ? (result.data as Record<string, unknown>) : null
    },
    summarize(config: unknown): string {
      if (typeId === 'browserAction') {
        const parsed = browserActionConfigSchema.safeParse(config)
        return parsed.success ? summarizeBrowserAction(parsed.data) : 'Finish this step in the inspector'
      }
      if (typeId === 'paperInstruments') {
        const parsed = paperConfigSchema.safeParse(config)
        return parsed.success ? summarizePaperInstruments(parsed.data) : 'Finish this step in the inspector'
      }
      if (typeId === 'delay') {
        const parsed = delayConfigSchema.safeParse(config)
        return parsed.success ? `${parsed.data.seconds}s` : 'Set a duration'
      }
      if (typeId === 'condition') {
        const parsed = conditionConfigSchema.safeParse(config)
        if (!parsed.success) return 'Configure what to check'
        const operatorLabel = parsed.data.operator
          .replace(/([A-Z])/g, ' $1')
          .toLowerCase()
          .replace(/^./, (c) => c.toUpperCase())
        if (!parsed.data.checkText) return 'Configure what to check'
        return parsed.data.operator === 'isEmpty' || parsed.data.operator === 'isNotEmpty'
          ? `If "${parsed.data.checkText}" — ${operatorLabel}`
          : parsed.data.contains
            ? `If "${parsed.data.checkText}" — ${operatorLabel} "${parsed.data.contains}"`
            : 'Configure what to check'
      }
      if (typeId === 'data') {
        const parsed = dataConfigSchema.safeParse(config)
        return parsed.success && parsed.data.value
          ? parsed.data.value.length > 60
            ? `${parsed.data.value.slice(0, 60)}…`
            : parsed.data.value
          : 'Empty text value'
      }
      if (typeId === 'join') {
        const parsed = joinConfigSchema.safeParse(config)
        return parsed.success
          ? parsed.data.behavior === 'all'
            ? 'Continue once all branches arrive'
            : 'Continue as soon as one branch arrives'
          : 'Choose how branches join'
      }
      if (typeId === 'trigger') {
        return 'Runs when you press Run'
      }
      return ''
    },
    requiredFields(config: unknown): string[] {
      if (typeId === 'browserAction') return browserActionRequired(config)
      return Object.keys(validateConfigFor(typeId, entry.schema, config))
    }
  }
}

export function defaultConfigFor(typeId: NodeTypeId): Record<string, unknown> {
  return structuredClone(DEFAULT_CONFIGS[typeId])
}

export interface NodeCreationTemplate {
  id: NodeTypeId
  label: string
  description: string
  defaultTitle: string
  iconOnly?: boolean
}

/** Library order drives the node palette and add-node menu. */
export const NODE_LIBRARY: NodeTypeId[] = [
  'trigger',
  'browserAction',
  'paperInstruments',
  'delay',
  'condition',
  'data',
  'join'
]

/* ------------------------------------------------------------------ */
/* Graph validation                                                    */
/* ------------------------------------------------------------------ */

export interface GraphValidationIssue {
  nodeId?: string
  edgeId?: string
  field?: string
  message: string
}

export interface GraphValidationResult {
  /** Structure is loadable: ids, endpoints, handles, types are sane. */
  structural: boolean
  structuralErrors: string[]
  /** Configuration is complete and valid per node type. */
  configIssues: GraphValidationIssue[]
}

export function emptyGraph(): WorkflowGraph {
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] }
}

/**
 * Deterministic validation of a workflow graph, used by the main process
 * as the persistence authority and by the renderer for honest UI states.
 *
 * - Structural problems (bad ids/types/edges/schemas) block saving.
 * - Per-node configuration problems do NOT block saving: a workflow with
 *   a half-configured step is still a record, but it cannot run later.
 */
export function validateWorkflowGraph(raw: unknown): GraphValidationResult {
  const structuralErrors: string[] = []
  const configIssues: GraphValidationIssue[] = []

  if (typeof raw !== 'object' || raw === null) {
    return {
      structural: false,
      structuralErrors: ['The workflow graph is missing.'],
      configIssues
    }
  }
  const graph = raw as Partial<WorkflowGraph>

  if (graph.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    structuralErrors.push(
      `This workflow uses schema version ${String(graph.schemaVersion)} which this app version does not understand.`
    )
    return { structural: false, structuralErrors, configIssues }
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph.edges) ? graph.edges : []

  if (nodes.length !== (graph.nodes?.length ?? 0) || edges.length !== (graph.edges?.length ?? 0)) {
    structuralErrors.push('Nodes and edges must be lists.')
  }

  // Node integrity -----------------------------------------------------
  const seenNodeIds = new Set<string>()
  const typedNodes = new Map<string, NodeTypeId>()
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) {
      structuralErrors.push('A node entry is malformed.')
      continue
    }
    const n = node as Partial<WorkflowNode>
    if (typeof n.id !== 'string' || n.id.length < 1 || n.id.length > 64 || /[^\w-]/.test(n.id)) {
      structuralErrors.push('A node has an invalid id.')
      continue
    }
    if (seenNodeIds.has(n.id)) {
      structuralErrors.push(`Node id "${n.id}" appears more than once.`)
      continue
    }
    seenNodeIds.add(n.id)
    if (!n.type || !isNodeTypeId(n.type)) {
      structuralErrors.push(`Node "${n.id}" has an unsupported type and was saved by an incompatible version.`)
      continue
    }
    typedNodes.set(n.id, n.type)
    if (
      typeof n.position !== 'object' ||
      n.position === null ||
      typeof (n.position as unknown as { x?: unknown; y?: unknown }).x !== 'number' ||
      typeof (n.position as unknown as { x?: unknown; y?: unknown }).y !== 'number'
    ) {
      structuralErrors.push(`Node "${n.id}" is missing its canvas position.`)
    }
    const definition = getNodeType(n.type)
    if (typeof n.config !== 'object' || n.config === null) {
      structuralErrors.push(`Node "${n.id}" has no configuration object.`)
      continue
    }
    const configErrors = definition.validateConfig(n.config)
    for (const [field, message] of Object.entries(configErrors)) {
      configIssues.push({ nodeId: n.id, field, message })
    }
    if (definition.parseConfig(n.config) === null) {
      structuralErrors.push(`Node "${n.id}" has a configuration of the wrong shape.`)
    }
  }

  // Edge integrity ------------------------------------------------------
  const seenEdgeIds = new Set<string>()
  for (const edge of edges) {
    if (typeof edge !== 'object' || edge === null) {
      structuralErrors.push('An edge entry is malformed.')
      continue
    }
    const e = edge as Partial<WorkflowEdge>
    if (typeof e.id !== 'string' || e.id.length < 1 || e.id.length > 64 || /[^\w-]/.test(e.id)) {
      structuralErrors.push('An edge has an invalid id.')
      continue
    }
    if (seenEdgeIds.has(e.id)) {
      structuralErrors.push(`Edge id "${e.id}" appears more than once.`)
      continue
    }
    seenEdgeIds.add(e.id)

    const sourceType = typedNodes.get(e.source ?? '')
    const targetType = typedNodes.get(e.target ?? '')
    if (typeof e.source !== 'string' || !sourceType) {
      structuralErrors.push('This connection points to a node that no longer exists.')
      continue
    }
    if (typeof e.target !== 'string' || !targetType) {
      structuralErrors.push('This connection points to a node that no longer exists.')
      continue
    }
    const sourceDef = getNodeType(sourceType)
    const targetDef = getNodeType(targetType)
    if (sourceDef.outputs.length === 0) {
      structuralErrors.push('The source node has nothing to connect out.')
    }
    if (e.sourceHandle && !sourceDef.outputs.some((out) => out.id === e.sourceHandle)) {
      structuralErrors.push(`The "${e.sourceHandle}" output does not exist on the source node.`)
    }
    if (!targetDef.acceptsInput) {
      structuralErrors.push('Only steps that follow the trigger can be connected as a target.')
    }
    if (e.source === e.target) {
      structuralErrors.push('A node cannot connect to itself.')
    }
  }

  // Directed cycles are rejected (an "obvious cycle" by construction). --
  if (structuralErrors.length === 0 && !isAcyclic(nodes as WorkflowNode[], edges as WorkflowEdge[])) {
    structuralErrors.push('This workflow contains a loop — every step must flow forward.')
  }

  return {
    structural: structuralErrors.length === 0,
    structuralErrors,
    configIssues
  }
}

/** True when the directed graph has no cycles (steps always flow forward). */
export function isAcyclic(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const adjacency = new Map<string, string[]>()
  for (const node of nodes) adjacency.set(node.id, [])
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target)
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (id: string): boolean => {
    if (done.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (!walk(next)) return false
    }
    visiting.delete(id)
    done.add(id)
    return true
  }
  for (const node of nodes) {
    if (!walk(node.id)) return false
  }
  return true
}

/** Human label for an output handle, for edge summaries and error text. */
export function outputLabel(typeId: NodeTypeId, handleId: string | undefined): string {
  const definition = getNodeType(typeId)
  return definition.outputs.find((out) => out.id === handleId)?.label ?? definition.outputs[0]?.label ?? 'Out'
}

/**
 * Connection gate for the editor: can `source` connect to `target`?
 * Returns a concise, honest reason when it cannot, or null when the
 * connection is valid. Used by the canvas before an edge is created so
 * invalid links never appear on the graph, not even briefly.
 */
export function explainConnection(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  source: string,
  target: string,
  sourceHandle?: string
): string | null {
  const sourceNode = nodes.find((n) => n.id === source)
  const targetNode = nodes.find((n) => n.id === target)
  if (!sourceNode || !targetNode) return 'Connect between two nodes on the canvas.'
  if (source === target) return 'A node cannot connect to itself.'
  const targetDef = getNodeType(targetNode.type)
  if (!targetDef.acceptsInput) return 'Only steps after the trigger can receive a connection.'
  const sourceDef = getNodeType(sourceNode.type)
  if (sourceHandle && !sourceDef.outputs.some((out) => out.id === sourceHandle)) {
    return 'That output handle does not exist on the source node.'
  }
  const duplicate = edges.some(
    (edge) => edge.source === source && edge.target === target && edge.sourceHandle === sourceHandle
  )
  if (duplicate) return 'These two nodes are already connected.'
  const candidate: WorkflowEdge = { id: 'candidate', source, target, ...(sourceHandle ? { sourceHandle } : {}) }
  if (!isAcyclic(nodes, [...edges, candidate])) {
    return 'This connection would create a loop — every step must flow forward.'
  }
  return null
}
