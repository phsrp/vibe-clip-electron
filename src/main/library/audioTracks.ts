// Video players in Chromium only play a file's first audio track. To let you hear (and mix)
// every track, each one is copied out of the clip into its own small audio file once (no
// re-encoding, so it's fast and lossless) and played alongside the video.
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { AudioTrackInfo } from '@shared/types'
import { createLogger } from '../logger'
import { getDb, type ClipRow } from './db'
import { mediaUrl } from './protocol'
import { run } from './media'
import { getSettings } from '../settings'

const log = createLogger('audio-tracks')

export function audioCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'thumbs', 'audio')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function streamCount(file: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], 20000)
  return out.trim().split(/\r?\n/).filter(Boolean).length
}

/** Loudest point of an audio file in dB (-91 = digital silence). Checks the first 10 minutes. */
async function loudness(file: string): Promise<number> {
  try {
    const out = await run('ffmpeg', ['-hide_banner', '-t', '600', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], 60000, true)
    const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(out)
    return m ? (m[1] === '-inf' ? -91 : Number(m[1])) : 0
  } catch {
    return 0
  }
}

const pending = new Map<string, Promise<AudioTrackInfo[]>>()

/** Each audio track of a clip as its own playable file (made once, then reused). */
export function audioTracks(clipId: number): Promise<AudioTrackInfo[]> {
  const row = getDb().prepare('SELECT * FROM clips WHERE id = ?').get(clipId) as ClipRow | undefined
  if (!row || row.kind === 'screenshot') return Promise.resolve([])
  let stamp = 0
  try {
    stamp = Math.round(fs.statSync(row.path).mtimeMs)
  } catch {
    return Promise.resolve([])
  }
  const key = `${clipId}_${stamp}`
  const existing = pending.get(key)
  if (existing) return existing
  const job = (async () => {
    const dir = audioCacheDir()
    // Remove files from an older version of this clip (e.g. it was replaced).
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${clipId}_`) && !f.startsWith(key)) fs.rmSync(path.join(dir, f), { force: true })
    const count = await streamCount(row.path)
    const names = getSettings().tracks
    const out: AudioTrackInfo[] = []
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `${key}_${i}.m4a`)
      const meta = file + '.json'
      if (!fs.existsSync(file)) {
        await run('ffmpeg', ['-y', '-v', 'error', '-i', row.path, '-map', `0:a:${i}`, '-c', 'copy', '-vn', file], 120000)
      }
      let peak: number
      try {
        peak = JSON.parse(fs.readFileSync(meta, 'utf8')).peak
      } catch {
        peak = await loudness(file)
        fs.writeFileSync(meta, JSON.stringify({ peak }))
      }
      out.push({ index: i, url: mediaUrl(file), name: names[i]?.name || `Track ${i + 1}`, silent: peak <= -80 })
    }
    log.info(`Clip ${clipId}: ${count} audio track(s) ready`)
    return out
  })()
  pending.set(key, job)
  job.catch(() => pending.delete(key))
  return job
}

/** Deletes the extracted audio of a clip (when the clip is deleted). */
export function forgetAudioTracks(clipId: number): void {
  try {
    const dir = audioCacheDir()
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${clipId}_`)) fs.rmSync(path.join(dir, f), { force: true })
  } catch {
    /* nothing cached */
  }
}
