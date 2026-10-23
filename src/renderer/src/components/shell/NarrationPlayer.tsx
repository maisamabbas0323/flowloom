import { useEffect, useRef } from 'react'
import { getApi } from '../../lib/api'
import type { NarrationPayload } from '../../../../shared/runTypes'

/**
 * Root-level player for optional voice narration.
 *
 * The main process performs the real ElevenLabs generation and pushes
 * bounded, template-based audio here; this component plays it through a
 * single HTML audio element in arrival order. Announcements are
 * deduplicated by their stable event keys, blob URLs are always revoked,
 * and mute (raised by the run panel during execution) stops the active
 * playback and clears pending audio at once. Future narration is then
 * suppressed at the source in the main process by the same preference.
 */

const MUTE_EVENT = 'flowloom:narration-mute'

const MAX_TRACKED_KEYS = 128

export function raiseNarrationMute(): void {
  window.dispatchEvent(new CustomEvent(MUTE_EVENT))
}

export function NarrationPlayer(): null {
  const mutedRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const queueRef = useRef<NarrationPayload[]>([])
  const playingRef = useRef(false)
  const seenKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    const api = getApi()
    const unsubscribe = api.onNarration((payload) => {
      if (mutedRef.current) return
      if (seenKeys.current.has(payload.eventKey)) return
      if (seenKeys.current.size > MAX_TRACKED_KEYS) seenKeys.current.clear()
      seenKeys.current.add(payload.eventKey)
      queueRef.current.push(payload)
      playNext()
    })
    const onMute = (): void => {
      mutedRef.current = true
      stopPlayback()
      queueRef.current = []
    }
    window.addEventListener(MUTE_EVENT, onMute)
    return () => {
      unsubscribe()
      window.removeEventListener(MUTE_EVENT, onMute)
      stopPlayback()
    }
  }, [])

  function stopPlayback(): void {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    revokeCurrent()
    playingRef.current = false
  }

  function revokeCurrent(): void {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }

  function playNext(): void {
    if (playingRef.current) return
    const next = queueRef.current.shift()
    if (!next) return
    playingRef.current = true
    try {
      const bytes = Uint8Array.from(atob(next.base64), (ch) => ch.charCodeAt(0))
      const blob = new Blob([bytes.buffer], { type: next.mimeType })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = audioRef.current ?? new Audio()
      audioRef.current = audio
      audio.src = url
      const speed = Number.isFinite(next.speed) ? Math.min(1.5, Math.max(0.7, next.speed)) : 1
      audio.playbackRate = speed
      audio.onended = () => {
        if (urlRef.current === url) urlRef.current = null
        URL.revokeObjectURL(url)
        playingRef.current = false
        playNext()
      }
      audio.onerror = () => {
        if (urlRef.current === url) urlRef.current = null
        URL.revokeObjectURL(url)
        playingRef.current = false
        playNext()
      }
      void audio.play().catch(() => {
        // Playback refusal (autoplay policy, no audio device): drop this
        // announcement — narration problems never affect the run.
        if (urlRef.current === url) urlRef.current = null
        URL.revokeObjectURL(url)
        playingRef.current = false
      })
    } catch {
      playingRef.current = false
    }
  }

  return null
}
