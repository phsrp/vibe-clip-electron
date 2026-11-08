// The clip library: keeps the database in sync with the files in your save folder,
// makes thumbnails, and answers the UI's requests (rename, delete, collections...).
import { app, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { Clip, ClipKind, Collection, GameSummary, LibrarySnapshot } from '@shared/types'
import { createLogger } from '../logger'
import { getDb, type ClipRow } from './db'
import { makeThumbnail, probe } from './media'
import { mediaUrl } from './protocol'
import { allGames, DESKTOP } from '../games/games'
import { forgetAudioTracks } from './audioTracks'

const log = createLogger('library')

export const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov'])
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg'])

export interface NewClipInfo {
  kind: ClipKind
  game: string
  gameName: string
  title: string
  createdAt?: number
}

type Listener = (snap: LibrarySnapshot) => void
const listeners: Listener[] = []
let emitTimer: NodeJS.Timeout | null = null
/** Files the app is still writing (e.g. a recording in progress): the scanner leaves them alone. */
const busyPaths = new Set<string>()
let gameIcons: Record<string, string> = {}

function thumbsDir(): string {
  const dir = path.join(app.getPath('userData'), 'thumbs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function onLibraryChange(l: Listener): void {
  listeners.push(l)
}

/** Tell the UI the library changed (batched so many quick changes send one update). */
function changed(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    const snap = snapshot()
    for (const l of listeners) l(snap)
  }, 120)
}

export function setGameIcons(icons: Record<string, string>): void {
  gameIcons = icons
  changed()
}

export function markBusy(file: string, busy: boolean): void {
  const key = file.toLowerCase()
  if (busy) busyPaths.add(key)
  else busyPaths.delete(key)
}

function rowToClip(r: ClipRow, collections: number[]): Clip {
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    kind: r.kind,
    game: r.game,
    gameName: r.game_name,
    createdAt: r.created_at,
    duration: r.duration,
    size: r.size,
    width: r.width,
    height: r.height,
    thumb: r.thumb ? mediaUrl(r.thumb) : null,
    url: mediaUrl(r.path),
    shared: r.shared === 1,
    collections
  }
}

export function snapshot(): LibrarySnapshot {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM clips ORDER BY created_at DESC').all() as unknown as ClipRow[]
  const links = db.prepare('SELECT collection_id, clip_id FROM collection_clips ORDER BY added_at').all() as {
    collection_id: number
    clip_id: number
  }[]
  const byClip = new Map<number, number[]>()
  for (const l of links) {
    const list = byClip.get(l.clip_id) ?? []
    list.push(l.collection_id)
    byClip.set(l.clip_id, list)
  }
  const clips = rows.map((r) => rowToClip(r, byClip.get(r.id) ?? []))

  // Games: every game that has clips, biggest first, Desktop last.
  const gameMap = new Map<string, GameSummary>()
  for (const c of clips) {
    const g = gameMap.get(c.game) ?? { id: c.game, name: c.gameName, count: 0, icon: gameIcons[c.game] ?? null }
    g.count++
    gameMap.set(c.game, g)
  }
  const games = [...gameMap.values()].sort((a, b) =>
    a.id === DESKTOP.id ? 1 : b.id === DESKTOP.id ? -1 : b.count - a.count || a.name.localeCompare(b.name)
  )

  const cols = db.prepare('SELECT id, name FROM collections ORDER BY created_at').all() as { id: number; name: string }[]
  const clipById = new Map(clips.map((c) => [c.id, c]))
  const collections: Collection[] = cols.map((col) => {
    const members = links.filter((l) => l.collection_id === col.id)
    const latest = members.map((m) => clipById.get(m.clip_id)).filter(Boolean).sort((a, b) => b!.createdAt - a!.createdAt)[0]
    return { id: col.id, name: col.name, count: members.length, cover: latest?.thumb ?? null }
  })

  return { clips, games, collections }
}

// ---------- Adding files ----------

let queue: Promise<unknown> = Promise.resolve()
/** Runs media work (ffprobe / thumbnails) one at a time so it doesn't slow the game down. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job, job)
  queue = p.catch(() => undefined)
  return p
}

/** Adds a file the app just created (or found). Returns the new clip's id. */
export async function addFile(file: string, info: NewClipInfo): Promise<number | null> {
  const db = getDb()
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (e) {
    log.error(`Can't add ${file}: file not found`, e)
    return null
  }
  const createdAt = info.createdAt ?? Math.round(stat.birthtimeMs || stat.mtimeMs)
  const res = db
    .prepare(
      `INSERT INTO clips (path, title, kind, game, game_name, created_at, size)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size`
    )
    .run(file, info.title, info.kind, info.game, info.gameName, createdAt, stat.size)
  const id = Number(res.lastInsertRowid) || (db.prepare('SELECT id FROM clips WHERE path = ?').get(file) as { id: number }).id
  changed()
  await enqueue(() => processMedia(id, file, info.kind))
  return id
}

async function processMedia(id: number, file: string, kind: ClipKind): Promise<void> {
  const db = getDb()
  try {
    const meta = await probe(file)
    const thumb = path.join(thumbsDir(), `${id}.jpg`)
    // Clips: the action is usually near the end. Recordings: a bit after the start.
    const at = kind === 'screenshot' ? 0 : kind === 'clip' ? meta.duration * 0.85 : Math.min(meta.duration * 0.1, 30)
    try {
      await makeThumbnail(file, thumb, at)
    } catch (e) {
      log.warn(`Thumbnail at ${at.toFixed(1)}s failed for ${file}, trying the first frame`, e)
      await makeThumbnail(file, thumb, 0)
    }
    const size = fs.statSync(file).size
    db.prepare('UPDATE clips SET duration = ?, width = ?, height = ?, size = ?, thumb = ? WHERE id = ?').run(
      kind === 'screenshot' ? 0 : meta.duration,
      meta.width,
      meta.height,
      size,
      thumb,
      id
    )
  } catch (e) {
    log.error(`Could not read ${file}`, e)
  }
  changed()
}

// ---------- Scanning the save folder ----------

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  )
}

/** Folder name used for a game's clips, safe for Windows. */
export function gameFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').trim() || 'Desktop'
}

function gameForFolder(root: string, file: string): { game: string; gameName: string } {
  const rel = path.relative(root, path.dirname(file))
  if (!rel || rel.startsWith('..')) return { game: DESKTOP.id, gameName: DESKTOP.name }
  const folder = rel.split(path.sep)[0]
  const known = allGames().find((g) => gameFolderName(g.name).toLowerCase() === folder.toLowerCase())
  if (known) return { game: known.id, gameName: known.name }
  if (folder.toLowerCase() === 'desktop') return { game: DESKTOP.id, gameName: DESKTOP.name }
  return { game: slug(folder), gameName: folder }
}

function kindForFile(file: string): ClipKind {
  const ext = path.extname(file).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'screenshot'
  return path.basename(file).toLowerCase().startsWith('recording') ? 'recording' : 'clip'
}

function listMedia(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) listMedia(full, depth - 1, out)
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (VIDEO_EXT.has(ext) || IMAGE_EXT.has(ext)) out.push(full)
    }
  }
}

/** Finds new files in the save folder and forgets clips whose files were deleted outside the app. */
export async function scan(root: string): Promise<void> {
  const db = getDb()
  fs.mkdirSync(root, { recursive: true })
  const files: string[] = []
  listMedia(root, 2, files)
  const known = new Set((db.prepare('SELECT path FROM clips').all() as { path: string }[]).map((r) => r.path.toLowerCase()))

  // Remove entries whose file is gone.
  const rows = db.prepare('SELECT id, path, thumb FROM clips').all() as { id: number; path: string; thumb: string | null }[]
  let removed = 0
  for (const r of rows) {
    if (!fs.existsSync(r.path) && !busyPaths.has(r.path.toLowerCase())) {
      db.prepare('DELETE FROM clips WHERE id = ?').run(r.id)
      if (r.thumb) fs.rmSync(r.thumb, { force: true })
      forgetAudioTracks(r.id)
      removed++
    }
  }

  const fresh = files.filter((f) => !known.has(f.toLowerCase()) && !busyPaths.has(f.toLowerCase()))
  log.info(`Scan of ${root}: ${files.length} files, ${fresh.length} new, ${removed} removed`)
  if (removed) changed()
  for (const f of fresh) {
    // MKV files with the "Recording" name might be a recording that's still going (e.g. after a crash): skip very recent ones.
    try {
      if (Date.now() - fs.statSync(f).mtimeMs < 5000) continue
    } catch {
      continue
    }
    const g = gameForFolder(root, f)
    await addFile(f, { kind: kindForFile(f), title: path.parse(f).name, ...g })
  }
}

/** Regenerates missing thumbnails (e.g. after the thumbs folder was cleared). */
export function repairThumbnails(): void {
  const rows = getDb().prepare('SELECT id, path, kind, thumb FROM clips').all() as { id: number; path: string; kind: ClipKind; thumb: string | null }[]
  for (const r of rows) {
    if ((!r.thumb || !fs.existsSync(r.thumb)) && fs.existsSync(r.path)) enqueue(() => processMedia(r.id, r.path, r.kind))
  }
}

// ---------- Actions from the UI ----------

function clipRow(id: number): ClipRow | undefined {
  return getDb().prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined
}

export function rename(id: number, title: string): void {
  const t = title.trim().slice(0, 200)
  if (!t) return
  getDb().prepare('UPDATE clips SET title = ? WHERE id = ?').run(t, id)
  changed()
}

/** Moves the files to the Recycle Bin (so a mistake can be undone) and removes them from the library. */
export async function remove(ids: number[]): Promise<string[]> {
  const errors: string[] = []
  for (const id of ids) {
    const r = clipRow(id)
    if (!r) continue
    try {
      if (fs.existsSync(r.path)) await shell.trashItem(r.path)
      getDb().prepare('DELETE FROM clips WHERE id = ?').run(id)
      if (r.thumb) fs.rmSync(r.thumb, { force: true })
      forgetAudioTracks(r.id)
      log.info(`Deleted ${r.path}`)
    } catch (e) {
      log.error(`Could not delete ${r.path}`, e)
      errors.push(`${r.title}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  changed()
  return errors
}

export function reveal(id: number): void {
  const r = clipRow(id)
  if (r) shell.showItemInFolder(r.path)
}

export function createCollection(name: string): void {
  const n = name.trim().slice(0, 80)
  if (!n) return
  getDb().prepare('INSERT INTO collections (name, created_at) VALUES (?, ?)').run(n, Date.now())
  changed()
}

export function deleteCollection(id: number): void {
  getDb().prepare('DELETE FROM collections WHERE id = ?').run(id)
  changed()
}

export function addToCollection(clipIds: number[], collectionId: number): void {
  const stmt = getDb().prepare('INSERT OR IGNORE INTO collection_clips (collection_id, clip_id, added_at) VALUES (?, ?, ?)')
  for (const id of clipIds) stmt.run(collectionId, id, Date.now())
  changed()
}

export function removeFromCollection(clipIds: number[], collectionId: number): void {
  const stmt = getDb().prepare('DELETE FROM collection_clips WHERE collection_id = ? AND clip_id = ?')
  for (const id of clipIds) stmt.run(collectionId, id)
  changed()
}

/** Is this path one of the app's own files (in the save folder or the thumbnails folder)? */
export function isLibraryPath(file: string, root: string): boolean {
  const f = path.resolve(file).toLowerCase()
  const inside = (dir: string) => f.startsWith(path.resolve(dir).toLowerCase() + path.sep)
  if (inside(root) || inside(thumbsDir())) return true
  return !!getDb().prepare('SELECT 1 FROM clips WHERE path = ?').get(file)
}
