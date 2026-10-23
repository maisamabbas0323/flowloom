import { extractProviderErrorText } from '../../providers/http'

/**
 * The minimal REST side of the Browserbase integration, using the
 * documented public API (https://api.browserbase.com/v1). It only
 * manages *session ownership* — creating a session and releasing it.
 * All browser control happens over CDP in `browserRunner.ts` via the
 * `connectUrl` the API returns. `fetch` is injectable so tests drive
 * the same code paths with controlled mock responses.
 *
 * Credentials never leave this layer, are never logged, and never
 * appear in errors.
 */

const API_BASE = 'https://api.browserbase.com/v1'
const REQUEST_TIMEOUT_MS = 20_000

export interface BrowserbaseCredentials {
  apiKey: string
  projectId: string
}

export interface CreatedSession {
  id: string
  status: string
  connectUrl: string
}

export type SessionCreateFailure =
  | { kind: 'auth'; message: string }
  | { kind: 'invalid_project'; message: string }
  | { kind: 'rate_limit'; message: string }
  | { kind: 'server'; message: string }
  | { kind: 'network'; message: string }

export type SessionRelease = 'released' | 'not_found' | 'unconfirmed'

export interface BrowserbaseClient {
  createSession(input: { timeoutSeconds: number }): Promise<CreatedSession | SessionCreateFailure>
  releaseSession(sessionId: string): Promise<SessionRelease>
}

export function createBrowserbaseClient(
  fetchImpl: typeof globalThis.fetch,
  credentials: BrowserbaseCredentials
): BrowserbaseClient {
  async function rawRequest(
    url: string,
    method: 'GET' | 'POST',
    body?: string
  ): Promise<{ ok: boolean; status: number; bodyText: string } | { ok: false; status: null; bodyText: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          'x-bb-api-key': credentials.apiKey,
          'Content-Type': 'application/json'
        },
        body,
        signal: controller.signal
      })
      const bodyText = await response.text().catch(() => '')
      return { ok: true, status: response.status, bodyText }
    } catch {
      return { ok: false, status: null, bodyText: '' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async createSession({ timeoutSeconds }) {
      const response = await rawRequest(`${API_BASE}/sessions`, 'POST', JSON.stringify({
        projectId: credentials.projectId,
        // Bounded by the node's own execution timeout; Browserbase
        // expects a whole-session lifetime in seconds (60–21600).
        timeout: Math.max(60, Math.ceil(timeoutSeconds * 2)),
        browserSettings: { recordSession: false, logSession: false }
      }))
      if (!response.ok || response.status === null) {
        return { kind: 'network', message: 'Could not reach api.browserbase.com to create the browser session.' }
      }
      if (response.status === 200 || response.status === 201) {
        const parsed = tryParseJson(response.bodyText) as
          | { id?: unknown; status?: unknown; connectUrl?: unknown }
          | null
        const id = typeof parsed?.id === 'string' ? parsed.id : null
        const connectUrl = typeof parsed?.connectUrl === 'string' ? parsed.connectUrl : null
        if (!id || !connectUrl) {
          return { kind: 'server', message: 'Browserbase returned a session response without the connection details Flowloom needs.' }
        }
        return { id, status: typeof parsed?.status === 'string' ? parsed.status : 'PENDING', connectUrl }
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: 'auth', message: 'Browserbase rejected the API key while creating the browser session.' }
      }
      if (response.status === 400 || response.status === 404) {
        if (/project/i.test(response.bodyText)) {
          return { kind: 'invalid_project', message: 'Browserbase does not recognize the configured project ID — check Settings.' }
        }
        return { kind: 'server', message: hintMessage(response.bodyText) ?? 'Browserbase refused to create the browser session.' }
      }
      if (response.status === 429) {
        return { kind: 'rate_limit', message: 'Browserbase is rate-limiting session creation right now — wait a moment and try again.' }
      }
      return { kind: 'server', message: `Browserbase could not create the browser session (status ${response.status}).` }
    },

    async releaseSession(sessionId) {
      // Documented close path: POST /v1/sessions/{id} with REQUEST_RELEASE.
      const response = await rawRequest(
        `${API_BASE}/sessions/${encodeURIComponent(sessionId)}`,
        'POST',
        JSON.stringify({ status: 'REQUEST_RELEASE' })
      )
      if (!response.ok) return 'unconfirmed'
      if (response.status === 200 || response.status === 202) return 'released'
      if (response.status === 404) {
        // The session already ended on its own — nothing left to clean up.
        return 'not_found'
      }
      return 'unconfirmed'
    }
  }
}

function hintMessage(bodyText: string): string | null {
  const hint = extractProviderErrorText(bodyText)
  return hint ? `Browserbase refused to create the browser session: ${hint}` : null
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
