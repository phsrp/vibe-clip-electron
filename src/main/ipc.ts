// Connects the UI's requests (from preload/index.ts) to the background modules.
import { dialog, ipcMain, shell, type FileFilter } from 'electron'
import { logPath } from './logger'
import { getSettings, updateSettings } from './settings'
import { BUILT_IN_GAMES } from './games/games'
import * as library from './library/library'
import { getMainWindow, toast } from './notify'
import { listProfiles } from './import/obs/profile'
import { importCollection, listCollections } from './import/obs/collection'
import { getProfiles, setProfiles } from './profiles/store'
import { SOURCE_TYPES, createSource } from './profiles/sourceTypes'
import { filterChoices, TRANSITION_NAMES } from './profiles/filterNames'
import { hidePreview, showPreview, type PreviewRect } from './preview'
import { HOTKEY_LABELS } from './hotkeys'
import { osn } from './engine/obs'
import type { CaptureService } from './capture/service'
import { cancelExport, exportEdit, makeStrip } from './editor/editor'
import { audioTracks } from './library/audioTracks'
import type { AppSettings, EditExportRequest, EngineStatus, ProfilesState, PropertyTarget, SourceKind } from '@shared/types'

export interface IpcDeps {
  engine: () => EngineStatus
  capture: CaptureService
  pauseHotkeys: (paused: boolean) => void
}

/** Wraps a handler so any error is logged and shown to you instead of failing silently. */
function safe<A extends unknown[], R>(what: string, fn: (...args: A) => R | Promise<R>) {
  return async (_e: unknown, ...args: A): Promise<R | undefined> => {
    try {
      return await fn(...args)
    } catch (e) {
      toast('error', `Couldn't ${what}`, e instanceof Error ? e.message : String(e))
      return undefined
    }
  }
}

/** OBS writes file filters like "Images (*.png *.jpg);;All Files (*.*)". */
function obsFilters(filter: string | undefined): FileFilter[] {
  if (!filter) return []
  return filter
    .split(';;')
    .map((part) => {
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(part.trim())
      if (!m) return null
      const exts = m[2]
        .split(/\s+/)
        .map((x) => x.replace(/^\*\.?/, ''))
        .filter(Boolean)
      return { name: m[1] || 'Files', extensions: exts.length ? exts.map((x) => (x === '*' ? '*' : x)) : ['*'] }
    })
    .filter((x): x is FileFilter => !!x)
}

export function registerIpc(deps: IpcDeps): void {
  const cap = deps.capture
  ipcMain.handle('engine:status', () => deps.engine())
  ipcMain.on('window:titlebar', (_e, bg: string, fg: string) => {
    try {
      getMainWindow()?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 34 })
    } catch {
      /* not supported */
    }
  })

  // ----- Library -----
  ipcMain.handle('library:get', safe('load the library', () => library.snapshot()))
  ipcMain.handle('library:rename', safe('rename the clip', (id: number, title: string) => library.rename(id, title)))
  ipcMain.handle(
    'library:remove',
    safe('delete', async (ids: number[]) => {
      const errors = await library.remove(ids)
      if (errors.length) toast('error', "Some files couldn't be deleted", errors.join('\n'))
    })
  )
  ipcMain.handle('library:reveal', safe('open the folder', (id: number) => library.reveal(id)))
  ipcMain.handle('library:createCollection', safe('create the collection', (name: string) => library.createCollection(name)))
  ipcMain.handle('library:deleteCollection', safe('delete the collection', (id: number) => library.deleteCollection(id)))
  ipcMain.handle('library:addToCollection', safe('add to the collection', (ids: number[], col: number) => library.addToCollection(ids, col)))
  ipcMain.handle(
    'library:removeFromCollection',
    safe('remove from the collection', (ids: number[], col: number) => library.removeFromCollection(ids, col))
  )

  // ----- Capture -----
  ipcMain.handle('capture:status', () => cap.status())
  ipcMain.handle('capture:options', safe('list capture devices', () => cap.options()))
  ipcMain.handle('capture:toggleReplay', safe('toggle the replay buffer', () => cap.toggleReplay()))
  ipcMain.handle('capture:toggleRecording', safe('start or stop recording', () => cap.toggleRecording()))
  ipcMain.handle('capture:toggleStream', safe('start or stop the stream', () => cap.toggleStream()))
  ipcMain.handle('capture:saveReplay', safe('save the clip', () => cap.saveReplay()))
  ipcMain.handle('capture:screenshot', safe('take a screenshot', () => cap.screenshot()))

  // ----- Profiles -----
  ipcMain.handle('profiles:get', () => getProfiles())
  ipcMain.handle('profiles:set', safe('save the profile', (state: ProfilesState) => setProfiles(state)))
  ipcMain.handle('profiles:sourceTypes', () => SOURCE_TYPES)
  ipcMain.handle(
    'profiles:newSource',
    safe('create the source', (kind: SourceKind, name: string) => {
      const v = cap.getScenes()?.getVideoConfig()
      return createSource(kind, name, v?.baseWidth ?? 1920, v?.baseHeight ?? 1080)
    })
  )
  ipcMain.handle('profiles:sourceSize', (_e, id: string) => cap.getScenes()?.sourceSize(id) ?? { width: 0, height: 0 })
  ipcMain.handle('profiles:canvas', () => {
    const v = cap.getScenes()?.getVideoConfig()
    return { width: v?.baseWidth ?? 1920, height: v?.baseHeight ?? 1080 }
  })
  ipcMain.handle('profiles:filterTypes', () => filterChoices(cap.getScenes()?.filterTypes() ?? []))
  ipcMain.handle('profiles:transitionTypes', () =>
    (cap.getScenes()?.transitionTypes() ?? Object.keys(TRANSITION_NAMES))
      .filter((t) => TRANSITION_NAMES[t])
      .map((t) => ({ id: t, label: TRANSITION_NAMES[t] }))
  )
  ipcMain.handle('mixer:audioIds', () => cap.audioSourceIds())

  // ----- Properties (generic OBS settings forms) -----
  ipcMain.handle('props:get', safe('read the settings', (target: PropertyTarget) => cap.getProperties(target)))
  ipcMain.handle('props:set', safe('change the setting', (target: PropertyTarget, name: string, value: unknown) => cap.setProperty(target, name, value)))
  ipcMain.handle('props:button', safe('run that action', (target: PropertyTarget, name: string) => cap.pressButton(target, name)))
  ipcMain.handle('props:pickPath', async (_e, mode: 'file' | 'save' | 'dir', filter: string, current: string) => {
    const w = getMainWindow()
    if (mode === 'save') {
      const r = w ? await dialog.showSaveDialog(w, { defaultPath: current || undefined, filters: obsFilters(filter) }) : await dialog.showSaveDialog({})
      return r.canceled ? null : r.filePath
    }
    const props: ('openFile' | 'openDirectory')[] = [mode === 'dir' ? 'openDirectory' : 'openFile']
    const opts = { defaultPath: current || undefined, properties: props, filters: mode === 'file' ? obsFilters(filter) : [] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })

  // ----- Preview -----
  ipcMain.on('preview:show', (_e, rect: PreviewRect, bg: { r: number; g: number; b: number }) => {
    const w = getMainWindow()
    const sc = cap.getScenes()
    if (w && sc) showPreview(w, sc.video, rect, bg)
  })
  ipcMain.on('preview:hide', () => hidePreview())
  ipcMain.on('preview:select', (_e, id: string | null) => cap.getScenes()?.selectSource(id))
  ipcMain.handle('profiles:sourceSizes', (_e, ids: string[]) => cap.getScenes()?.sourceSizes(ids) ?? {})

  ipcMain.handle('media:audioTracks', safe('read the audio tracks', (clipId: number) => audioTracks(clipId)))

  // ----- Clip editor -----
  ipcMain.handle('editor:strip', safe('prepare the timeline', (clipId: number) => makeStrip(clipId)))
  ipcMain.handle('editor:export', async (e, req: EditExportRequest) => {
    try {
      const id = await exportEdit(req, (p) => e.sender.send('editor:progress', p))
      if (id) toast('success', 'Edit saved', 'Your edited clip is in the library next to the original.')
      return id
    } catch (err) {
      toast('error', "The edit couldn't be exported", err instanceof Error ? err.message : String(err))
      return null
    }
  })
  ipcMain.handle('editor:cancel', () => cancelExport())

  // ----- Streaming -----
  ipcMain.handle('stream:setKey', safe('save the stream key', (key: string) => cap.setStreamKey(key)))

  // ----- Settings -----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', safe('save settings', (patch: Partial<AppSettings>) => updateSettings(patch)))
  ipcMain.handle('settings:pickFolder', async () => {
    const w = getMainWindow()
    const opts = { title: 'Choose where to save clips', defaultPath: getSettings().outputFolder, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('settings:openLogs', () => shell.showItemInFolder(logPath()))
  ipcMain.handle('settings:pauseHotkeys', (_e, paused: boolean) => deps.pauseHotkeys(paused))
  ipcMain.handle('settings:hotkeyLabels', () => HOTKEY_LABELS)
  ipcMain.handle('settings:monitoringDevices', () => {
    try {
      return osn.AudioFactory.monitoringDevices.map((d) => ({ id: d.id, name: d.name }))
    } catch {
      return []
    }
  })
  ipcMain.handle('games:builtIn', () => BUILT_IN_GAMES)
  ipcMain.handle('obs:listProfiles', safe('read your OBS profiles', () => listProfiles(getSettings())))
  const canvasAndTypes = () => {
    const v = cap.getScenes()?.getVideoConfig()
    return { canvas: { width: v?.baseWidth ?? 1920, height: v?.baseHeight ?? 1080 }, types: deps.engine().inputTypes }
  }
  ipcMain.handle(
    'obs:listCollections',
    safe('read your OBS scene collections', () => {
      const { canvas, types } = canvasAndTypes()
      return listCollections(canvas, types)
    })
  )
  ipcMain.handle(
    'obs:importCollection',
    safe('import the scene collection', (file: string, replaceAudio: boolean) => {
      const { canvas, types } = canvasAndTypes()
      return setProfiles(importCollection(file, getProfiles(), canvas, types, replaceAudio))
    })
  )
}
