// Serves your clips and thumbnails to the UI through a private "media://" address.
// Supports seeking (HTTP range requests) so the built-in player can jump around big files.
import { protocol } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { createLogger } from '../logger'

const log = createLogger('media')

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/mp4',
  '.mkv': 'video/webm',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

export function mediaUrl(file: string): string {
  let v = 0
  try {
    v = Math.round(fs.statSync(file).mtimeMs)
  } catch {
    /* missing file: the UI shows a placeholder */
  }
  return `media://file/${encodeURIComponent(file)}?v=${v}`
}

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export function handleMediaProtocol(isAllowed: (file: string) => boolean): void {
  protocol.handle('media', async (req) => {
    const url = new URL(req.url)
    const file = decodeURIComponent(url.pathname.slice(1))
    if (!isAllowed(file)) {
      log.warn(`Blocked request for ${file}`)
      return new Response('Forbidden', { status: 403 })
    }
    let size: number
    try {
      size = fs.statSync(file).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const range = req.headers.get('range')
    const match = range && /bytes=(\d*)-(\d*)/.exec(range)
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : size - 1
      if (!match[1] && match[2]) {
        start = size - Number(match[2])
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const stream = fs.createReadStream(file, { start, end })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          // Lets the player route the sound through Web Audio (per-track volume above 100%).
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes',
          // Lets the player route the sound through Web Audio (per-track volume above 100%).
          'Access-Control-Allow-Origin': '*' }
    })
  })
}
