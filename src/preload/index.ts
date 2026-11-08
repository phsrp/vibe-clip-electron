// The safe bridge between the UI and the background process.
// The UI can only call the functions listed here.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  AudioTrackInfo,
  CaptureOptions,
  CaptureStatus,
  EditExportRequest,
  EditStrip,
  EngineStatus,
  GameDefinition,
  LibrarySnapshot,
  MixerLevels,
  ObsCollectionPreview,
  ObsProfilePreview,
  ProfileSource,
  ProfilesState,
  PropertyTarget,
  SerializedProperty,
  SourceKind,
  SourceTypeInfo,
  ToastMessage,
  UpdateStatus
} from '@shared/types'

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  engineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke('engine:status'),
  setTitleBarColors: (bg: string, fg: string): void => ipcRenderer.send('window:titlebar', bg, fg),

  library: {
    get: (): Promise<LibrarySnapshot> => ipcRenderer.invoke('library:get'),
    rename: (id: number, title: string): Promise<void> => ipcRenderer.invoke('library:rename', id, title),
    remove: (ids: number[]): Promise<void> => ipcRenderer.invoke('library:remove', ids),
    reveal: (id: number): Promise<void> => ipcRenderer.invoke('library:reveal', id),
    createCollection: (name: string): Promise<void> => ipcRenderer.invoke('library:createCollection', name),
    deleteCollection: (id: number): Promise<void> => ipcRenderer.invoke('library:deleteCollection', id),
    addToCollection: (clipIds: number[], collectionId: number): Promise<void> =>
      ipcRenderer.invoke('library:addToCollection', clipIds, collectionId),
    removeFromCollection: (clipIds: number[], collectionId: number): Promise<void> =>
      ipcRenderer.invoke('library:removeFromCollection', clipIds, collectionId),
    onChange: (cb: (snap: LibrarySnapshot) => void) => listen('library:changed', cb)
  },

  capture: {
    status: (): Promise<CaptureStatus> => ipcRenderer.invoke('capture:status'),
    options: (): Promise<CaptureOptions> => ipcRenderer.invoke('capture:options'),
    toggleReplay: (): Promise<void> => ipcRenderer.invoke('capture:toggleReplay'),
    toggleRecording: (): Promise<void> => ipcRenderer.invoke('capture:toggleRecording'),
    saveReplay: (): Promise<void> => ipcRenderer.invoke('capture:saveReplay'),
    screenshot: (): Promise<void> => ipcRenderer.invoke('capture:screenshot'),
    onStatus: (cb: (s: CaptureStatus) => void) => listen('capture:status', cb)
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:pickFolder'),
    openLogs: (): Promise<void> => ipcRenderer.invoke('settings:openLogs'),
    /** Temporarily turn off global hotkeys while the user is typing a new one. */
    pauseHotkeys: (paused: boolean): Promise<void> => ipcRenderer.invoke('settings:pauseHotkeys', paused),
    hotkeyLabels: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:hotkeyLabels'),
    monitoringDevices: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke('settings:monitoringDevices'),
    onChange: (cb: (s: AppSettings) => void) => listen('settings:changed', cb)
  },

  profiles: {
    get: (): Promise<ProfilesState> => ipcRenderer.invoke('profiles:get'),
    set: (state: ProfilesState): Promise<ProfilesState | undefined> => ipcRenderer.invoke('profiles:set', state),
    sourceTypes: (): Promise<SourceTypeInfo[]> => ipcRenderer.invoke('profiles:sourceTypes'),
    newSource: (kind: SourceKind, name: string): Promise<ProfileSource | undefined> => ipcRenderer.invoke('profiles:newSource', kind, name),
    sourceSize: (id: string): Promise<{ width: number; height: number }> => ipcRenderer.invoke('profiles:sourceSize', id),
    canvas: (): Promise<{ width: number; height: number }> => ipcRenderer.invoke('profiles:canvas'),
    filterTypes: (): Promise<{ id: string; label: string; audio: boolean }[]> => ipcRenderer.invoke('profiles:filterTypes'),
    transitionTypes: (): Promise<{ id: string; label: string }[]> => ipcRenderer.invoke('profiles:transitionTypes'),
    onChange: (cb: (s: ProfilesState) => void) => listen('profiles:changed', cb)
  },

  mixer: {
    audioIds: (): Promise<string[]> => ipcRenderer.invoke('mixer:audioIds'),
    onLevels: (cb: (l: MixerLevels) => void) => listen('mixer:levels', cb)
  },

  props: {
    get: (target: PropertyTarget): Promise<SerializedProperty[] | undefined> => ipcRenderer.invoke('props:get', target),
    set: (target: PropertyTarget, name: string, value: unknown): Promise<SerializedProperty[] | undefined> =>
      ipcRenderer.invoke('props:set', target, name, value),
    button: (target: PropertyTarget, name: string): Promise<void> => ipcRenderer.invoke('props:button', target, name),
    pickPath: (mode: 'file' | 'save' | 'dir', filter: string, current: string): Promise<string | null> =>
      ipcRenderer.invoke('props:pickPath', mode, filter, current)
  },

  preview: {
    show: (rect: { x: number; y: number; width: number; height: number }, bg: { r: number; g: number; b: number }): void =>
      ipcRenderer.send('preview:show', rect, bg),
    hide: (): void => ipcRenderer.send('preview:hide'),
    select: (id: string | null): void => ipcRenderer.send('preview:select', id),
    sourceSizes: (ids: string[]): Promise<Record<string, { width: number; height: number }>> => ipcRenderer.invoke('profiles:sourceSizes', ids)
  },

  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    snooze: (): Promise<void> => ipcRenderer.invoke('update:snooze'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    debug: (s: UpdateStatus): Promise<void> => ipcRenderer.invoke('update:debug', s),
    onStatus: (cb: (s: UpdateStatus) => void) => listen('update:status', cb)
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  media: {
    /** Each audio track of a clip as its own playable file. */
    audioTracks: (clipId: number): Promise<AudioTrackInfo[] | undefined> => ipcRenderer.invoke('media:audioTracks', clipId)
  },

  editor: {
    strip: (clipId: number): Promise<EditStrip | undefined> => ipcRenderer.invoke('editor:strip', clipId),
    export: (req: EditExportRequest): Promise<number | null> => ipcRenderer.invoke('editor:export', req),
    cancel: (): Promise<void> => ipcRenderer.invoke('editor:cancel'),
    onProgress: (cb: (p: number) => void) => listen('editor:progress', cb)
  },

  stream: {
    toggle: (): Promise<void> => ipcRenderer.invoke('capture:toggleStream'),
    setKey: (key: string): Promise<void> => ipcRenderer.invoke('stream:setKey', key)
  },

  obs: {
    /** Finds OBS Studio profiles on this PC and previews what would be imported. */
    listProfiles: (): Promise<ObsProfilePreview[] | undefined> => ipcRenderer.invoke('obs:listProfiles'),
    listCollections: (): Promise<ObsCollectionPreview[] | undefined> => ipcRenderer.invoke('obs:listCollections'),
    importCollection: (file: string, replaceAudio: boolean): Promise<ProfilesState | undefined> =>
      ipcRenderer.invoke('obs:importCollection', file, replaceAudio)
  },

  games: {
    builtIn: (): Promise<GameDefinition[]> => ipcRenderer.invoke('games:builtIn')
  },

  onToast: (cb: (t: ToastMessage) => void) => listen('toast', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
