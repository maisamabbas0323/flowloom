import { request, extractProviderErrorText, networkFailure } from './http'
import { failure, success, type ProviderContext, type ProviderTestResult } from './types'

/**
 * Google AI (Gemini API) connection test.
 *
 * Uses the official Generative Language REST API. The test performs a
 * minimal generation request against the exact model id the user supplied
 * — a success therefore proves connectivity, authentication AND that the
 * user-provided model id can actually serve requests. `maxOutputTokens: 1`
 * keeps the request as cheap as the API allows.
 */
export async function testGoogle(
  ctx: ProviderContext,
  input: { apiKey: string; modelId: string }
): Promise<ProviderTestResult> {
  // Step 1 — auth check via the (free) models listing endpoint.
  try {
    const response = await request(ctx, {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      method: 'GET',
      headers: { 'x-goog-api-key': input.apiKey }
    })
    if (response.status === 401 || response.status === 403) {
      return failure('auth', 'Google rejected the API key.')
    }
    if (response.status === 400) {
      // Google reports invalid API keys as 400 INVALID_ARGUMENT.
      return failure('auth', 'Google rejected the API key.', providerHint(response.bodyText))
    }
    if (response.status !== 200) {
      return failure(
        response.status === 429 ? 'rate_limit' : 'server_error',
        'Google returned an unexpected response while verifying the API key.'
      )
    }
  } catch (error) {
    return toFailedRequest(error, 'generativelanguage.googleapis.com')
  }

  // Step 2 — model verification with a minimal, real generation request.
  try {
    const response = await request(ctx, {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.modelId)}:generateContent`,
      method: 'POST',
      headers: {
        'x-goog-api-key': input.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 }
      })
    })

    if (response.status === 200) {
      return success('Connection verified. The selected model responded to a minimal request.')
    }
    if (response.status === 404 || response.status === 400) {
      if (looksLikeKeyError(response.bodyText)) {
        return failure('auth', 'Google rejected the API key while checking the model.')
      }
      return failure(
        'model_not_found',
        `Google does not serve the model id "${input.modelId}". Check the exact ID supplied by your provider.`,
        providerHint(response.bodyText)
      )
    }
    if (response.status === 401 || response.status === 403) {
      return failure('auth', 'Google rejected the API key while checking the model.')
    }
    if (response.status === 429) {
      return failure('rate_limit', 'Google rate-limited this API key. Try again shortly.')
    }
    return failure('server_error', 'Google returned an unexpected response while checking the model.')
  } catch (error) {
    return toFailedRequest(error, 'generativelanguage.googleapis.com')
  }
}

function looksLikeKeyError(bodyText: string): boolean {
  return bodyText.includes('API key not valid') || bodyText.includes('API_KEY_INVALID')
}

function providerHint(bodyText: string): string | undefined {
  return extractProviderErrorText(bodyText)
}

function toFailedRequest(error: unknown, host: string): ProviderTestResult {
  const mapped = networkFailure(error, host)
  return failure(mapped.code, mapped.message)
}
