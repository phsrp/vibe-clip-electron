// Types shared by the background process (main) and the UI (renderer).

export interface EncoderInfo {
  id: string
  label: string
  hardware: boolean
}

export interface EngineStatus {
  running: boolean
  error: string | null
  encoders: EncoderInfo[]
  inputTypes: string[]
}

export type ClipKind = 'clip' | 'recording' | 'screenshot'

export interface Clip {
  id: number
  path: string
  title: string
  kind: ClipKind
  /** Game id from the games list, or "desktop". */
  game: string
  gameName: string
  /** Unix time in milliseconds. */
  createdAt: number
  /** Seconds. 0 for screenshots. */
  duration: number
  /** Bytes. */
  size: number
  width: number
  height: number
  /** URL the UI can load (thumbnail image), or null while it's being made. */
  thumb: string | null
  /** URL the built-in player can load. */
  url: string
  shared: boolean
  collections: number[]
}

export interface GameSummary {
  id: string
  name: string
  count: number
  /** URL of the game's icon, or null to use a generic icon. */
  icon: string | null
}

export interface Collection {
  id: number
  name: string
  count: number
  cover: string | null
}

export interface LibrarySnapshot {
  clips: Clip[]
  games: GameSummary[]
  collections: Collection[]
}

/** Which clips the sidebar is showing. */
export type LibraryView =
  | { type: 'all' }
  | { type: 'game'; id: string }
  | { type: 'collection'; id: number }

export type KindFilter = 'all' | 'clips' | 'screenshots'
export type SortOrder = 'newest' | 'oldest' | 'largest' | 'longest'

export interface CaptureStatus {
  replayActive: boolean
  replaySeconds: number
  recording: boolean
  /** Unix ms when recording started. */
  recordingSince: number | null
  game: string | null
  gameName: string | null
  stream: StreamStatus
  activeProfile: string | null
}

export type OutputResolution = 'native' | '2160' | '1440' | '1080' | '900' | '720'

export interface Hotkeys {
  saveReplay: string
  toggleRecording: string
  screenshot: string
  toggleReplay: string
  toggleStream: string
  muteMic: string
}

export interface AppSettings {
  theme: string
  /** Every theme comes in a dark and a light version. */
  themeMode: 'dark' | 'light'
  /** Where clips, recordings and screenshots are saved. */
  outputFolder: string
  // ----- Video (OBS: Settings → Video) -----
  /** Canvas size: "auto" = your primary display, or "WIDTHxHEIGHT". */
  baseResolution: string
  /** Saved video size: "native" (= canvas), a height like "1080", or "WIDTHxHEIGHT". */
  outputResolution: OutputResolution | string
  downscaleFilter: 'bilinear' | 'bicubic' | 'lanczos' | 'area'
  /** Frame rate as a fraction fps/fpsDen: 60/1, or 60000/1001 for 59.94. */
  fps: number
  fpsDen: number
  // ----- Recording (OBS: Settings → Output → Recording) -----
  /** "auto" = best available (NVENC > AMF > QuickSync > x264). */
  encoder: string
  /** Kbps (used by CBR/VBR rate control). */
  bitrate: number
  /** Exact encoder settings (every option the encoder offers), in OBS's format. */
  encoderOverrides: { id: string; settings: Record<string, unknown> } | null
  /** Recordings are written as MKV (crash-safe) and converted to this when they finish. */
  recordingFormat: 'mp4' | 'mkv' | 'mov'
  /** OBS filename format, e.g. "%CCYY-%MM-%DD %hh-%mm-%ss". */
  filenameFormat: string
  /** Which of the 6 audio tracks go into recordings (bitmask: track 1 = 1, track 2 = 2, track 3 = 4...). */
  recordTracks: number
  splitRecording: { enabled: boolean; type: 'time' | 'size'; minutes: number; megabytes: number }
  // ----- Replay buffer -----
  replayEnabled: boolean
  replaySeconds: number
  replayTracks: number
  // ----- Audio (OBS: Settings → Audio + Output → Audio) -----
  sampleRate: 44100 | 48000
  channels: 'mono' | 'stereo' | '2.1' | '4.0' | '4.1' | '5.1' | '7.1'
  tracks: { name: string; bitrate: number }[]
  monitoringDevice: string
  disableDucking: boolean
  // ----- Advanced (OBS: Settings → Advanced) -----
  colorFormat: 'NV12' | 'I420' | 'I444' | 'BGRA'
  colorSpace: '601' | '709' | 'sRGB' | '2100PQ' | '2100HLG'
  colorRange: 'partial' | 'full'
  // ----- Streaming (OBS: Settings → Stream + Output → Streaming) -----
  stream: StreamSettings
  // ----- Hotkeys (Electron accelerator strings, e.g. "Alt+F10") -----
  hotkeys: Hotkeys
  // ----- App -----
  minimizeToTray: boolean
  startWithWindows: boolean
  /** Check for a new version when the app opens (it always asks before downloading). */
  autoUpdate: boolean
  /** Extra games added by the user. */
  customGames: GameDefinition[]
  // ----- Phase 1 capture settings (moved into profiles; only read once for migration) -----
  captureMode?: 'auto' | 'display'
  monitorId?: string
  desktopAudio?: boolean
  desktopAudioDevice?: string
  mic?: boolean
  micDevice?: string
}

export interface StreamSettings {
  /** OBS service id: "rtmp_common" (Twitch, YouTube...), "rtmp_custom" or "whip_custom". */
  serviceType: string
  /** Service name for rtmp_common, e.g. "Twitch". */
  service: string
  server: string
  /** Stream key, stored encrypted with Windows' own protection. Empty in the UI. */
  keyEncrypted: string
  /** "same" = same encoder type as recording (separate instance), or an encoder id. */
  encoder: string
  bitrate: number
  encoderOverrides: Record<string, unknown> | null
  /** Audio track (1-6) sent to the stream. */
  track: number
  /** "none" or a height like "720" to scale the stream down. */
  rescale: string
  reconnect: { enabled: boolean; delaySec: number; maxRetries: number }
  delaySec: number
}

// ----- Profiles (OBS "scenes") -----

export type SourceKind =
  | 'display'
  | 'window'
  | 'game'
  | 'auto_game'
  | 'webcam'
  | 'mic'
  | 'desktop_audio'
  | 'app_audio'
  | 'image'
  | 'slideshow'
  | 'text'
  | 'media'
  | 'browser'
  | 'color'
  | 'other'

export interface SourceTransform {
  /** fit = scale to fit the canvas, stretch = fill it, custom = use the values below. */
  fit: 'fit' | 'stretch' | 'custom'
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  /** OBS alignment flags (5 = top-left). */
  alignment: number
  /** OBS bounds type (0 none, 1 stretch, 2 scale inner, 3 scale outer, 4 to width, 5 to height, 6 max only). */
  boundsType: number
  boundsWidth: number
  boundsHeight: number
  boundsAlignment: number
  crop: { left: number; top: number; right: number; bottom: number }
}

export interface AudioSettings {
  /** Linear volume (1 = 0 dB). */
  volume: number
  muted: boolean
  /** Which tracks this source goes to (bitmask, 6 tracks). */
  mixers: number
  /** 0 = off, 1 = monitor only (mute output), 2 = monitor and output. */
  monitoring: number
  syncOffsetMs: number
  /** Downmix to mono. */
  mono?: boolean
  balance?: number
}

export interface FilterConfig {
  id: string
  name: string
  /** OBS filter id, e.g. "color_filter_v2". */
  type: string
  enabled: boolean
  settings: Record<string, unknown>
}

export interface ProfileSource {
  id: string
  name: string
  /** OBS input id, e.g. "monitor_capture". */
  obsType: string
  kind: SourceKind
  settings: Record<string, unknown>
  visible: boolean
  transform: SourceTransform
  audio: AudioSettings
  filters: FilterConfig[]
}

export interface Profile {
  id: string
  name: string
  sources: ProfileSource[]
  /** Global hotkey that switches to this profile. */
  hotkey: string
}

export interface TransitionSettings {
  type: string
  durationMs: number
  settings: Record<string, unknown>
}

export interface ProfilesState {
  profiles: Profile[]
  activeId: string
  /** Desktop audio and microphones that are always on, whatever the profile (OBS "global audio devices"). */
  globalAudio: ProfileSource[]
  transition: TransitionSettings
}

/** One OBS setting, described so the UI can draw the right control. */
export interface SerializedProperty {
  name: string
  label: string
  description: string
  type:
    | 'bool'
    | 'int'
    | 'float'
    | 'text'
    | 'path'
    | 'list'
    | 'color'
    | 'color_alpha'
    | 'button'
    | 'font'
    | 'editable_list'
    | 'frame_rate'
    | 'group'
    | 'capture'
    | 'unknown'
  visible: boolean
  enabled: boolean
  value: unknown
  min?: number
  max?: number
  step?: number
  slider?: boolean
  textMode?: 'default' | 'password' | 'multiline' | 'info'
  pathMode?: 'file' | 'save' | 'dir'
  filter?: string
  items?: { label: string; value: string | number; enabled: boolean }[]
  /** For lists: true if the user may type a custom value. */
  editable?: boolean
}

/** What the properties editor is editing. */
export type PropertyTarget =
  | { kind: 'source'; sourceId: string }
  | { kind: 'filter'; sourceId: string; filterId: string }
  | { kind: 'transition' }
  | { kind: 'encoder'; encoderId: string; use: 'record' | 'stream' }
  | { kind: 'service'; serviceType: string }

export interface SourceTypeInfo {
  kind: SourceKind
  obsType: string
  label: string
  description: string
  audioOnly: boolean
}

export interface MixerChannel {
  id: string
  name: string
  global: boolean
  audio: AudioSettings
}

/** Peak level per source in dB (-60 = silence .. 0 = loudest). */
export type MixerLevels = Record<string, number[]>

export interface StreamStatus {
  live: boolean
  starting: boolean
  since: number | null
  kbps: number
  droppedFrames: number
  totalFrames: number
}

// ----- Updates -----

export interface UpdateStatus {
  state: 'idle' | 'dev' | 'checking' | 'uptodate' | 'available' | 'snoozed' | 'downloading' | 'ready' | 'error'
  version?: string
  current?: string
  notes?: string[]
  percent?: number
  during?: 'check' | 'download'
}

// ----- Multi-track audio playback -----

export interface AudioTrackInfo {
  /** 0-based audio track number in the file. */
  index: number
  /** Playable URL of just this track. */
  url: string
  /** Name from Settings → Audio tracks. */
  name: string
  /** True if the track has no sound at all. */
  silent: boolean
}

// ----- Clip editor -----

export interface EditStrip {
  duration: number
  width: number
  height: number
  /** One image with `stripCount` frames side by side. */
  strip: string
  stripCount: number
  /** Audio waveform image, or null if the clip has no audio. */
  wave: string | null
  /** One waveform image per audio track (null if it couldn't be drawn). */
  waves: (string | null)[]
  audioStreams: number
}

export interface EditSegment {
  /** Seconds in the original clip. */
  start: number
  end: number
  /** Playback speed of this part (1 = normal, 2 = twice as fast). */
  speed: number
}

export interface EditTrack {
  /** Include this track in the exported clip. */
  keep: boolean
  /** Hear it while editing (doesn't change the export). */
  listen: boolean
  /** 1 = 100%, up to 2. */
  volume: number
}

export interface EditAudio {
  tracks: EditTrack[]
  /** Seconds. */
  fadeIn: number
  fadeOut: number
  /** true = mix the kept tracks into one track; false = keep them as separate tracks. */
  mix: boolean
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface EditExportRequest {
  clipId: number
  segments: EditSegment[]
  crop: CropRect | null
  audio: EditAudio
}

export interface ObsCollectionPreview {
  name: string
  file: string
  profiles: { name: string; sources: number }[]
  imported: string[]
  skipped: string[]
}

export interface ObsProfilePreview {
  name: string
  folder: string
  /** The settings that would change. */
  patch: Partial<AppSettings>
  /** Human-readable list of what gets imported. */
  imported: string[]
  /** What can't be imported (yet), and why. */
  skipped: string[]
}

export interface GameDefinition {
  id: string
  name: string
  /** Process names to look for, e.g. ["osu!.exe"]. Case-insensitive. */
  processes: string[]
  /** Where the game is usually installed (used to show its icon before you've played it). */
  installHints?: {
    /** Full paths to try; %LOCALAPPDATA% style variables work. */
    paths?: string[]
    /** Folders with one subfolder per version (Roblox): the newest one containing `versionExe` wins. */
    versionDirs?: string[]
    versionExe?: string
    /** Path inside a Steam library's steamapps\common folder. */
    steam?: string
  }
}

export interface DeviceOption {
  id: string
  name: string
}

export interface CaptureOptions {
  monitors: DeviceOption[]
  desktopAudioDevices: DeviceOption[]
  micDevices: DeviceOption[]
  encoders: EncoderInfo[]
}

export type ToastKind = 'success' | 'error' | 'info'
export interface ToastMessage {
  id: number
  kind: ToastKind
  title: string
  detail?: string
}
