// The clip editor's background work: timeline pictures (thumbnail strip + a waveform per audio
// track) and exporting the edit (kept parts joined, each at its own speed, optionally cropped,
// with per-track volume, fades, and tracks kept separate or mixed) as a new clip with FFmpeg.
import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { EditExportRequest, EditStrip } from '@shared/types'
import { createLogger } from '../logger'
import { mediaUrl } from '../library/protocol'
import * as library from '../library/library'
import { getDb, type ClipRow } from '../library/db'
import { lowPriority, probe } from '../library/media'
import { resolveEncoder } from '../engine/encoders'
import { getSettings } from '../settings'

const log = createLogger('editor')

function ffmpegPath(): string {
  return path.join(path.dirname(require.resolve('obs-studio-node')).replace('app.asar', 'app.asar.unpacked'), 'ffmpeg.exe')
}

function thumbsDir(): string {
  const dir = path.join(app.getPath('userData'), 'thumbs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function run(args: string[], timeout = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpegPath(), args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' '))) : resolve()
    )
    lowPriority(child)
  })
}

/** Thumbnail strip (one image with N frames side by side) and one waveform picture per audio track. */
export async function makeStrip(clipId: number): Promise<EditStrip> {
  const row = getDb().prepare('SELECT * FROM clips WHERE id = ?').get(clipId) as ClipRow | undefined
  if (!row) throw new Error('Clip not found')
  const info = await probe(row.path)
  const count = 24
  const strip = path.join(thumbsDir(), `strip_${clipId}.jpg`)
  const fresh = (f: string) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= fs.statSync(row.path).mtimeMs
  if (!fresh(strip)) {
    const rate = Math.max(count / Math.max(info.duration, 0.1), 0.01)
    await run(['-y', '-v', 'error', '-i', row.path, '-vf', `fps=${rate.toFixed(5)},scale=160:-2,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', strip])
  }
  const streams = await audioStreamCount(row.path)
  const waves: (string | null)[] = []
  for (let i = 0; i < streams; i++) {
    const wave = path.join(thumbsDir(), `wave_${clipId}_${i}.png`)
    if (!fresh(wave)) {
      try {
        await run(['-y', '-v', 'error', '-i', row.path, '-filter_complex', `[0:a:${i}]aformat=channel_layouts=mono,showwavespic=s=2400x60:colors=white:scale=sqrt`, '-frames:v', '1', wave])
      } catch (e) {
        log.warn(`No waveform for track ${i + 1}`, e)
      }
    }
    waves.push(fs.existsSync(wave) ? mediaUrl(wave) : null)
  }
  return {
    duration: info.duration,
    width: info.width,
    height: info.height,
    strip: mediaUrl(strip),
    stripCount: count,
    wave: waves[0] ?? null,
    waves,
    audioStreams: streams
  }
}

async function audioStreamCount(file: string): Promise<number> {
  return new Promise((resolve) => {
    const probePath = ffmpegPath().replace('ffmpeg.exe', 'ffprobe.exe')
    execFile(probePath, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { windowsHide: true }, (err, out) =>
      resolve(err ? 0 : out.trim().split(/\r?\n/).filter(Boolean).length)
    )
  })
}

let current: ChildProcess | null = null
let cancelled = false

/** Which FFmpeg H.264 encoder to use, matching the GPU your recordings use. */
function exportEncoder(): string {
  const id = resolveEncoder(getSettings().encoder)
  if (id.includes('nvenc')) return 'h264_nvenc'
  if (id.includes('amf')) return 'h264_amf'
  if (id.includes('qsv')) return 'h264_qsv'
  return 'libx264'
}

function encoderArgs(enc: string): string[] {
  if (enc === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
  if (enc === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '21']
  if (enc === 'h264_qsv') return ['-c:v', 'h264_qsv', '-global_quality', '20']
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
}

/** FFmpeg's atempo only goes from 0.5x to 2x, so bigger changes are chained (4x = 2x then 2x). */
function atempo(speed: number): string {
  const parts: number[] = []
  let s = speed
  while (s > 2) {
    parts.push(2)
    s /= 2
  }
  while (s < 0.5) {
    parts.push(0.5)
    s /= 0.5
  }
  parts.push(s)
  return parts.map((p) => `atempo=${p.toFixed(5)}`).join(',')
}

function buildFilter(req: EditExportRequest, streams: number): { filter: string; maps: string[]; total: number } {
  const n = (x: number) => x.toFixed(3)
  const speed = (s: { speed?: number }) => Math.min(4, Math.max(0.25, s.speed || 1))
  const total = req.segments.reduce((t, s) => t + (s.end - s.start) / speed(s), 0)
  // Tracks that go into the export (in their original order).
  const kept = Array.from({ length: streams }, (_, i) => i).filter((i) => req.audio.tracks[i]?.keep !== false)
  const parts: string[] = []
  const concatIn: string[] = []
  req.segments.forEach((s, i) => {
    const sp = speed(s)
    parts.push(`[0:v]trim=start=${n(s.start)}:end=${n(s.end)},setpts=(PTS-STARTPTS)/${sp}[v${i}]`)
    concatIn.push(`[v${i}]`)
    kept.forEach((a, k) => {
      const tempo = sp === 1 ? '' : `,${atempo(sp)}`
      parts.push(`[0:a:${a}]atrim=start=${n(s.start)}:end=${n(s.end)},asetpts=PTS-STARTPTS${tempo}[a${i}_${k}]`)
      concatIn.push(`[a${i}_${k}]`)
    })
  })
  const catOut = ['[vcat]', ...kept.map((_, k) => `[ac${k}]`)]
  parts.push(`${concatIn.join('')}concat=n=${req.segments.length}:v=1:a=${kept.length}${catOut.join('')}`)

  let vLabel = '[vcat]'
  if (req.crop) {
    const even = (x: number) => Math.max(2, Math.floor(x / 2) * 2)
    parts.push(`[vcat]crop=${even(req.crop.width)}:${even(req.crop.height)}:${Math.round(req.crop.x)}:${Math.round(req.crop.y)}[vout]`)
    vLabel = '[vout]'
  }

  // Per-track volume, then fades.
  const fadeIn = Math.min(Math.max(0, req.audio.fadeIn), total)
  const fadeOut = Math.min(Math.max(0, req.audio.fadeOut), total)
  const audioOut: string[] = []
  kept.forEach((a, k) => {
    const f: string[] = []
    const vol = req.audio.tracks[a]?.volume ?? 1
    if (Math.abs(vol - 1) > 0.001) f.push(`volume=${vol.toFixed(3)}`)
    if (fadeIn > 0) f.push(`afade=t=in:st=0:d=${n(fadeIn)}`)
    if (fadeOut > 0) f.push(`afade=t=out:st=${n(Math.max(0, total - fadeOut))}:d=${n(fadeOut)}`)
    if (!f.length) f.push('anull')
    parts.push(`[ac${k}]${f.join(',')}[ao${k}]`)
    audioOut.push(`[ao${k}]`)
  })
  if (req.audio.mix && audioOut.length > 1) {
    parts.push(`${audioOut.join('')}amix=inputs=${audioOut.length}:normalize=0:duration=longest[amix]`)
    return { filter: parts.join(';'), maps: [vLabel, '[amix]'], total }
  }
  return { filter: parts.join(';'), maps: [vLabel, ...audioOut], total }
}

/** Exports the edit as a new clip next to the original. Calls onProgress with 0..1. */
export async function exportEdit(req: EditExportRequest, onProgress: (p: number) => void): Promise<number | null> {
  const row = getDb().prepare('SELECT * FROM clips WHERE id = ?').get(req.clipId) as ClipRow | undefined
  if (!row) throw new Error('Clip not found')
  if (!req.segments.length) throw new Error('Nothing to export: every part was removed')
  const streams = await audioStreamCount(row.path)
  const dir = path.dirname(row.path)
  const base = path.parse(row.path).name.replace(/ \(edited( \d+)?\)$/, '')
  let out = path.join(dir, `${base} (edited).mp4`)
  for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `${base} (edited ${i}).mp4`)

  const { filter, maps, total } = buildFilter(req, streams)
  log.info(`Export audio settings: ${JSON.stringify(req.audio)}`)
  const hasAudio = maps.length > 1
  const attempt = (enc: string) =>
    new Promise<void>((resolve, reject) => {
      const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', row.path, '-filter_complex', filter]
      for (const m of maps) args.push('-map', m)
      args.push(...encoderArgs(enc), '-pix_fmt', 'yuv420p')
      if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k')
      args.push('-movflags', '+faststart', out)
      const speeds = [...new Set(req.segments.map((s) => s.speed || 1))].join('/')
      log.info(`Exporting ${req.segments.length} part(s) at ${speeds}x, ${total.toFixed(1)}s, ${maps.length - 1} audio track(s)${req.audio.mix ? ' mixed' : ''}, ${enc}${req.crop ? ', cropped' : ''} -> ${out}`)
      const p = spawn(ffmpegPath(), args, { windowsHide: true })
      lowPriority(p)
      current = p
      let err = ''
      p.stdout.on('data', (d: Buffer) => {
        const m = /out_time_us=(\d+)/.exec(d.toString())
        if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / Math.max(total, 0.1)))
      })
      p.stderr.on('data', (d: Buffer) => (err += d.toString()))
      p.on('close', (code) => {
        current = null
        if (cancelled) reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `FFmpeg exited with code ${code}`))
      })
    })

  cancelled = false
  library.markBusy(out, true)
  try {
    const enc = exportEncoder()
    try {
      await attempt(enc)
    } catch (e) {
      if (cancelled || enc === 'libx264') throw e
      log.warn(`${enc} export failed, retrying with x264`, e)
      onProgress(0)
      await attempt('libx264')
    }
  } catch (e) {
    fs.rmSync(out, { force: true })
    if (cancelled) return null
    throw e
  } finally {
    library.markBusy(out, false)
  }
  onProgress(1)
  const id = await library.addFile(out, {
    kind: row.kind === 'screenshot' ? 'clip' : row.kind,
    game: row.game,
    gameName: row.game_name,
    title: `${row.title.replace(/ \(edited\)$/, '')} (edited)`
  })
  return id
}

export function cancelExport(): void {
  if (current) {
    cancelled = true
    current.kill()
  }
}
