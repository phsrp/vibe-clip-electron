// Reads video info and makes thumbnails / remuxes using the ffmpeg.exe and ffprobe.exe
// that ship inside the OBS engine package (no separate FFmpeg install needed).
import { execFile, type ChildProcess } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { createLogger } from '../logger'

const log = createLogger('ffmpeg')

export function toolPath(name: 'ffmpeg' | 'ffprobe'): string {
  const dir = path.dirname(require.resolve('obs-studio-node')).replace('app.asar', 'app.asar.unpacked')
  return path.join(dir, `${name}.exe`)
}

/** Background work runs below normal priority so a game you're playing keeps its frame rate. */
export function lowPriority(child: ChildProcess): void {
  try {
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    /* the process may already be done */
  }
}

/** Runs ffmpeg/ffprobe. `withStderr` also returns what it printed to stderr (where volumedetect reports). */
export function run(tool: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs = 60000, withStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(toolPath(tool), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${tool} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`))
      else resolve(withStderr ? stdout + stderr : stdout)
    })
    lowPriority(child)
  })
}

export interface MediaInfo {
  duration: number
  width: number
  height: number
}

export async function probe(file: string): Promise<MediaInfo> {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 20000)
  const data = JSON.parse(out) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]
  }
  const video = data.streams?.find((s) => s.codec_type === 'video')
  const duration = Number(data.format?.duration ?? video?.duration ?? 0)
  return { duration: Number.isFinite(duration) ? duration : 0, width: video?.width ?? 0, height: video?.height ?? 0 }
}

/** Saves a 480px-wide JPEG frame taken `atSeconds` into the video (or a scaled copy of an image). */
export async function makeThumbnail(file: string, out: string, atSeconds: number): Promise<void> {
  const args = ['-y', '-v', 'error']
  if (atSeconds > 0) args.push('-ss', atSeconds.toFixed(2))
  args.push('-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out)
  await run('ffmpeg', args, 30000)
}

/** Copies the audio/video into a new container without re-encoding (fast). Used to turn MKV recordings into MP4. */
export async function remux(input: string, output: string): Promise<void> {
  log.info(`Remuxing ${input} -> ${output}`)
  await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output], 30 * 60 * 1000)
}
