import { request, extractProviderErrorText, networkFailure } from './http'
import { failure, success, type ProviderContext, type ProviderTestResult } from './types'

/**
 * OpenRouter connection test.
 *
 * Uses OpenRouter's supported chat completions API with a minimal
 * single-token request against the user-supplied model id, so success
 * covers connectivity, authentication and real model availability.
 */
export async function testOpenRouter(
  ctx: ProviderContext,
  input: { apiKey: string; modelId: string }
): Promise<ProviderTestResult> {
  try {
    const response = await request(ctx, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: input.modelId,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      })
    })

    if (response.status === 200) {
      return success('Connection verified. The selected model accepted a minimal request.')
    }
    if (response.status === 401 || response.status === 403) {
      return failure('auth', 'OpenRouter rejected the API key.', providerHint(response.bodyText))
    }
    if (response.status === 404) {
      return failure(
        'model_not_found',
        `OpenRouter does not serve the model id "${input.modelId}". Check the exact ID supplied by your provider.`,
        providerHint(response.bodyText)
      )
    }
    if (response.status === 400) {
      const body = response.bodyText
      if (/no endpoints found|not a valid model|invalid model/i.test(body)) {
        return failure(
          'model_not_found',
          `OpenRouter reports that "${input.modelId}" has no available provider. Check the exact ID supplied by your provider.`,
          providerHint(body)
        )
      }
      if (/api key|invalid key/i.test(body)) {
        return failure('auth', 'OpenRouter rejected the API key.', providerHint(body))
      }
      return failure('unknown', 'OpenRouter rejected the request.', providerHint(body))
    }
    if (response.status === 429) {
      return failure('rate_limit', 'OpenRouter rate-limited this API key. Try again shortly.')
    }
    return failure('server_error', 'OpenRouter returned an unexpected response.')
  } catch (error) {
    const mapped = networkFailure(error, 'openrouter.ai')
    return failure(mapped.code, mapped.message)
  }
}

function providerHint(bodyText: string): string | undefined {
  return extractProviderErrorText(bodyText)
}
