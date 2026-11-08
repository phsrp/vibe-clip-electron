// Which audio tracks you like to hear, remembered between clips (your track setup is the same
// for all of them). Kept in this computer's browser storage; if that's unavailable the defaults apply.
import type { AudioTrackInfo } from '@shared/types'
import type { TrackMix } from './multitrack'

const KEY = 'vibeclip.playerTracks'

interface Saved {
  tracks: TrackMix[]
  master: number
  muted: boolean
}

export function loadPrefs(): Saved | null {
  try {
    const v = localStorage.getItem(KEY)
    return v ? (JSON.parse(v) as Saved) : null
  } catch {
    return null
  }
}

export function savePrefs(p: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable: settings just aren't remembered */
  }
}

/**
 * First time (nothing saved): every track that has sound. If track 1 is the default
 * "Everything" mix and other tracks have sound too, track 1 is left off so nothing plays twice.
 */
export function defaultMix(tracks: AudioTrackInfo[]): TrackMix[] {
  const others = tracks.slice(1).some((t) => !t.silent)
  return tracks.map((t, i) => ({
    enabled: !t.silent && !(i === 0 && others && /everything/i.test(t.name)),
    volume: 1
  }))
}

export function mixFor(tracks: AudioTrackInfo[]): TrackMix[] {
  const saved = loadPrefs()
  const defaults = defaultMix(tracks)
  if (!saved) return defaults
  return tracks.map((_, i) => saved.tracks[i] ?? defaults[i])
}
