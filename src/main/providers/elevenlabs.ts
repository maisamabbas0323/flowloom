import { request, extractProviderErrorText, networkFailure } from './http'
import { failure, success, type ProviderContext, type ProviderTestResult } from './types'

/**
 * ElevenLabs provider support.
 *
 * `testVoiceConnection` verifies the API key (account lookup).
 * `testVoiceGeneration` further verifies the user-supplied voice ID and
 * performs a short real text-to-speech request. A voice id is never
 * invented — one must come from Settings or the environment, and an
 * unknown/inaccessible voice id yields an honest failure.
 */
export async function testVoiceConnection(
  ctx: ProviderContext,
  input: { apiKey: string }
): Promise<ProviderTestResult> {
  try {
    const response = await request(ctx, {
      url: 'https://api.elevenlabs.io/v1/user/subscription',
      method: 'GET',
      headers: { 'xi-api-key': input.apiKey }
    })
    if (response.status === 401 || response.status === 403) {
      return failure('auth', 'ElevenLabs rejected the API key.', providerHint(response.bodyText))
    }
    if (response.status === 404) {
      return failure('auth', 'The ElevenLabs API key was not accepted.', providerHint(response.bodyText))
    }
    if (response.status === 429) {
      return failure('rate_limit', 'ElevenLabs rate-limited the API key. Try again shortly.')
    }
    if (response.status !== 200) {
      return failure('server_error', 'ElevenLabs returned an unexpected response while verifying the API key.', providerHint(response.bodyText))
    }
    return success('Connection verified with ElevenLabs.')
  } catch (error) {
    return toFailedRequest(error, 'api.elevenlabs.io')
  }
}

export interface VoiceGenerationOutcome {
  connection: ProviderTestResult | null
  audio?: { mimeType: string; base64: string }
}

export function getVoice(
  ctx: ProviderContext,
  input: { apiKey: string; voiceId: string }
): Promise<ProviderTestResult> {
  return performVoiceLookup(ctx, input)
}

async function performVoiceLookup(
  ctx: ProviderContext,
  input: { apiKey: string; voiceId: string }
): Promise<ProviderTestResult> {
  try {
    const response = await request(ctx, {
      url: `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(input.voiceId)}`,
      method: 'GET',
      headers: { 'xi-api-key': input.apiKey }
    })
    if (response.status === 200) {
      return success('Voice ID verified against the account.')
    }
    if (response.status === 401 || response.status === 403) {
      return failure('auth', 'ElevenLabs rejected the API key while checking the voice.', providerHint(response.bodyText))
    }
    if (response.status === 404) {
      return failure(
        'voice_not_found',
        `The voice ID "${input.voiceId}" is unknown or not available to this ElevenLabs account.`,
        providerHint(response.bodyText)
      )
    }
    return failure(
      'server_error',
      'ElevenLabs returned an unexpected response while checking the voice.',
      providerHint(response.bodyText)
    )
  } catch (error) {
    return toFailedRequest(error, 'api.elevenlabs.io')
  }
}

/**
 * Performs the actual TTS request. The binary audio payload is read as
 * bytes (never through a text decoder) and returned base64-encoded for
 * renderer playback — audio never touches the filesystem and credentials
 * never appear in any URL or log.
 */
export async function testVoiceGeneration(
  ctx: ProviderContext,
  input: { apiKey: string; voiceId: string }
): Promise<VoiceGenerationOutcome> {
  return generateSpeech(ctx, input, 'Flowloom voice test.')
}

/**
 * Real text-to-speech for any bounded, safe text (voice test, optional
 * narration). No retries: a failed or rate-limited request is reported,
 * never repeated — automatic retries could consume provider credits.
 */
export async function generateSpeech(
  ctx: ProviderContext,
  input: { apiKey: string; voiceId: string },
  text: string
): Promise<VoiceGenerationOutcome> {
  const lookup = await performVoiceLookup(ctx, input)
  if (!lookup.ok) return { connection: lookup }

  try {
    const response = await request(ctx, {
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}`,
      method: 'POST',
      headers: {
        'xi-api-key': input.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        output_format: 'mp3_44100_128'
      }),
      timeoutMs: 30_000,
      binary: true
    })
    if (response.status === 200) {
      const bytes = response.bodyBytes
      if (!bytes || bytes.byteLength < 16) {
        return {
          connection: failure('unknown', 'The voice generation returned no audio.')
        }
      }
      return {
        connection: null,
        audio: { mimeType: 'audio/mpeg', base64: bytes.toString('base64') }
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { connection: failure('auth', 'ElevenLabs rejected the API key during generation.', providerHint(response.bodyText)) }
    }
    if (response.status === 404) {
      return {
        connection: failure(
          'voice_not_found',
          `The voice ID "${input.voiceId}" is not available for speech generation.`,
          providerHint(response.bodyText)
        )
      }
    }
    if (response.status === 429) {
      return { connection: failure('rate_limit', 'ElevenLabs rate-limited the account. Try again shortly.') }
    }
    return {
      connection: failure(
        'server_error',
        'ElevenLabs could not generate the test audio.',
        providerHint(response.bodyText)
      )
    }
  } catch (error) {
    return { connection: toFailedRequest(error, 'api.elevenlabs.io') }
  }
}

function providerHint(bodyText: string): string | undefined {
  return extractProviderErrorText(bodyText)
}

function toFailedRequest(error: unknown, host: string): ProviderTestResult {
  const mapped = networkFailure(error, host)
  return failure(mapped.code, mapped.message)
}
