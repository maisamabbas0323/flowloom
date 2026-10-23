import { request, extractProviderErrorText, networkFailure } from './http'
import { failure, success, type ProviderContext, type ProviderTestResult } from './types'

/**
 * Browserbase connection test.
 *
 * Uses the official Browserbase REST API (api.browserbase.com). The test
 * performs a real, authenticated `GET /v1/sessions` request with the
 * configured API key — a read-only listing call, so no browser session
 * is created and no billable usage occurs. A 401/403 means the key was
 * rejected; a network error is reported as unreachable. The configured
 * project ID is checked syntactically here and fully verified by the
 * API at run time (project scope is enforced when sessions are created).
 */
export async function testBrowserbase(
  ctx: ProviderContext,
  input: { apiKey: string; projectId: string }
): Promise<ProviderTestResult> {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(input.projectId)) {
    return failure(
      'invalid_target',
      `The project ID "${input.projectId}" does not look like a Browserbase project ID — copy it exactly from your Browserbase settings.`
    )
  }

  let response: { status: number; bodyText: string }
  try {
    response = await request(ctx, {
      url: 'https://api.browserbase.com/v1/sessions',
      method: 'GET',
      headers: { 'x-bb-api-key': input.apiKey }
    })
  } catch (error) {
    return toFailedRequest(error, 'api.browserbase.com')
  }

  if (response.status === 200) {
    return success(
      'Connection verified. The API key was accepted by Browserbase (a read-only check — no browser session was created).',
      input.projectId !== '' ? `project: ${input.projectId}` : undefined
    )
  }
  if (response.status === 401 || response.status === 403) {
    return failure('auth', 'Browserbase rejected the API key.', providerHint(response.bodyText))
  }
  if (response.status === 429) {
    return failure('rate_limit', 'Browserbase is rate-limiting requests — try again shortly.', providerHint(response.bodyText))
  }
  return failure('server_error', 'Browserbase returned an unexpected response while verifying the API key.', providerHint(response.bodyText))
}

function providerHint(bodyText: string): string | undefined {
  return extractProviderErrorText(bodyText)
}

function toFailedRequest(error: unknown, host: string): ProviderTestResult {
  const mapped = networkFailure(error, host)
  return failure(mapped.code, mapped.message)
}
