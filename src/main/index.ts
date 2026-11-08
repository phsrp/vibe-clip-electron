// App entry point: starts the OBS engine, the library, hotkeys, game detection and the tray,
// and opens the window.
import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { createLogger, logPath } from './logger'
import { execFile } from 'child_process'
import { engineDir, isEngineRunning, startEngine, stopEngine, watchEngine, osn } from './engine/obs'
import { applyUpdateSchedule, installUpdate, setupUpdater, updateReady } from './updater'
import { availableEncoders } from './engine/encoders'
import { getSettings, onSettingsChange } from './settings'
import * as library from './library/library'
import { registerMediaScheme, handleMediaProtocol } from './library/protocol'
import { closeDb } from './library/db'
import { registerIpc } from './ipc'
import { send, setMainWindow, setOverlayToast, toast } from './notify'
import { pauseHotkeys, registerHotkeys, unregisterHotkeys, type ExtraHotkey, type HotkeyActions } from './hotkeys'
import { flushProfiles, getProfiles, mapSource, onProfilesChange, setProfiles } from './profiles/store'
import { hidePreview } from './preview'
import { destroyOverlay, showOverlayToast } from './overlay'
import { GameDetector, savedIcons } from './games/detector'
import { findGameIcons } from './games/icons'
import { allGames } from './games/games'
import { CaptureService } from './capture/service'
import { createTray, destroyTray, resourcePath, updateTray } from './tray'
import type { EngineStatus } from '@shared/types'

const log = createLogger('app')
let win: BrowserWindow | null = null
const engine: EngineStatus = { running: false, error: null, encoders: [], inputTypes: [] }
const capture = new CaptureService()
const detector = new GameDetector()
let quitting = false
let trayHintShown = false

// Developer helper: VIBE_DATA_DIR=<folder> keeps settings, database and logs separate (for testing).
if (process.env['VIBE_DATA_DIR']) app.setPath('userData', process.env['VIBE_DATA_DIR'])
// Hidden tests make no sound either.
if (process.env['VIBE_HIDDEN']) app.commandLine.appendSwitch('mute-audio')

// Only one copy of the app may run (two would fight over the engine and hotkeys).
if (!process.env['VIBE_CAPTURE'] && !app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => showWindow())

registerMediaScheme()

process.on('uncaughtException', (e) => log.error('Uncaught exception', e))
process.on('unhandledRejection', (e) => log.error('Unhandled promise rejection', e))

function showWindow(): void {
  if (!win) createWindow()
  if (win!.isMinimized()) win!.restore()
  win!.show()
  win!.focus()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 800,
    minWidth: 960,
    minHeight: 580,
    backgroundColor: '#111114',
    show: false,
    icon: resourcePath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111114', symbolColor: '#9a9aa5', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  setMainWindow(win)
  // VIBE_HIDDEN (developer tests): never show the window, so testing doesn't interrupt a game.
  const startHidden = process.argv.includes('--hidden') || !!process.env['VIBE_HIDDEN']
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
  })

  // Closing the window hides it to the tray (the replay buffer keeps running).
  win.on('close', (e) => {
    if (quitting) return
    if (getSettings().minimizeToTray) {
      e.preventDefault()
      win?.hide()
      if (!trayHintShown) {
        trayHintShown = true
        showOverlayToast({ id: 0, kind: 'info', title: 'Vibe Clip is still running', detail: 'In the tray, with the replay buffer on' })
      }
    } else {
      app.quit()
    }
  })
  win.on('closed', () => {
    win = null
    setMainWindow(null)
  })

  // If the UI crashes, log it and reload instead of leaving a blank window.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`UI process crashed: ${details.reason}`)
    if (details.reason !== 'clean-exit') setTimeout(() => win?.reload(), 500)
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))

  // Developer helper: VIBE_CAPTURE=<file.png> saves a screenshot of the window and quits.
  const shot = process.env['VIBE_CAPTURE']
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env['VIBE_CAPTURE_JS']) {
          await win!.webContents.executeJavaScript(process.env['VIBE_CAPTURE_JS']).catch((e) => log.error('Test script failed', e))
        }
        await new Promise((r) => setTimeout(r, 800))
        // A window that was never shown can still be captured off-screen; give up after a few seconds.
        if (win!.isVisible() || process.env['VIBE_HIDDEN']) {
          const img = await Promise.race([win!.webContents.capturePage(), new Promise<null>((r) => setTimeout(() => r(null), 5000))])
          if (img && !img.isEmpty()) fs.writeFileSync(shot, img.toPNG())
        }
        quitting = true
        app.quit()
      }, Number(process.env['VIBE_CAPTURE_DELAY'] ?? 3000))
    })
  }
}

function report(what: string) {
  return (e: unknown) => toast('error', `Couldn't ${what}`, e instanceof Error ? e.message : String(e))
}

app.whenReady().then(async () => {
  log.info(`App starting (v${app.getVersion()}). Log file: ${logPath()}`)
  try {
    startEngine()
    engine.running = true
    engine.encoders = availableEncoders()
    engine.inputTypes = osn.InputFactory.types()
  } catch (e) {
    engine.error = e instanceof Error ? e.message : String(e)
    log.error('Engine failed to start', e)
  }

  handleMediaProtocol((file) => library.isLibraryPath(file, getSettings().outputFolder))
  library.onLibraryChange((snap) => send('library:changed', snap))
  registerIpc({ engine: () => engine, capture, pauseHotkeys })
  // In hidden tests, never pop anything up over the screen.
  setOverlayToast(process.env['VIBE_HIDDEN'] ? () => {} : showOverlayToast)
  createWindow()
  // "Restart now" on an update: save/stop everything and wait for the engine before installing.
  setupUpdater(async () => {
    shuttingDown = true
    await shutdownAll()
    await waitForEngineExit()
  })

  const actions: HotkeyActions = {
    saveReplay: () => void capture.saveReplay().catch(report('save the clip')),
    toggleRecording: () => void capture.toggleRecording().catch(report('start or stop recording')),
    screenshot: () => void capture.screenshot().catch(report('take a screenshot')),
    toggleReplay: () => void capture.toggleReplay().catch(report('toggle the replay buffer')),
    toggleStream: () => void capture.toggleStream().catch(report('start or stop the stream')),
    muteMic: () => {
      const st = getProfiles()
      const mic = st.globalAudio.find((s) => s.kind === 'mic')
      if (!mic) return
      const muted = !mic.audio.muted
      setProfiles(mapSource(st, mic.id, (s) => ({ ...s, audio: { ...s.audio, muted } })))
      showOverlayToast({ id: 0, kind: 'info', title: muted ? 'Microphone muted' : 'Microphone on' })
    }
  }
  const profileHotkeys = (): ExtraHotkey[] =>
    getProfiles()
      .profiles.filter((p) => p.hotkey)
      .map((p) => ({ accelerator: p.hotkey, label: `Switch to "${p.name}"`, action: () => setProfiles({ ...getProfiles(), activeId: p.id }) }))
  registerHotkeys(getSettings().hotkeys, actions, profileHotkeys())

  createTray({
    show: showWindow,
    saveClip: actions.saveReplay,
    toggleRecording: actions.toggleRecording,
    screenshot: actions.screenshot,
    toggleReplay: actions.toggleReplay,
    toggleStream: actions.toggleStream,
    quit: () => app.quit()
  })
  capture.onStatus = (s) => {
    send('capture:status', s)
    updateTray(s, getSettings().hotkeys)
  }
  updateTray(capture.status(), getSettings().hotkeys)

  // Audio levels for the mixer: sent ~20x a second, only while the window is visible.
  let lastLevels = 0
  capture.onLevels = (levels) => {
    const now = Date.now()
    if (now - lastLevels < 45 || !win?.isVisible()) return
    lastLevels = now
    send('mixer:levels', levels)
  }

  onProfilesChange((next, prev) => {
    if (engine.running) {
      try {
        capture.applyProfiles(next, prev)
      } catch (e) {
        report('apply the profile change')(e)
      }
    }
    send('profiles:changed', next)
    const hk = (s: typeof next) => s.profiles.map((p) => p.id + p.hotkey + p.name).join()
    if (hk(next) !== hk(prev)) registerHotkeys(getSettings().hotkeys, actions, profileHotkeys())
  })

  onSettingsChange((next, prev) => {
    send('settings:changed', next)
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) {
      registerHotkeys(next.hotkeys, actions, profileHotkeys())
      updateTray(capture.status(), next.hotkeys)
    }
    if (next.autoUpdate !== prev.autoUpdate) applyUpdateSchedule()
    if (next.startWithWindows !== prev.startWithWindows) {
      app.setLoginItemSettings({ openAtLogin: next.startWithWindows, args: ['--hidden'] })
    }
    if (next.outputFolder !== prev.outputFolder) library.scan(next.outputFolder).catch((e) => log.error('Library scan failed', e))
    if (engine.running) capture.applySettings(next, prev).catch(report('apply settings'))
  })

  await library.scan(getSettings().outputFolder).catch((e) => log.error('Library scan failed', e))
  library.repairThumbnails()

  if (engine.running) {
    try {
      await capture.init()
      if (restartedAfterCrash) toast('info', 'Vibe Clip restarted its recording engine', 'It had stopped unexpectedly. Clips and recording work again.')
    } catch (e) {
      engine.error = 'The capture setup failed: ' + (e instanceof Error ? e.message : String(e))
      log.error('Capture init failed', e)
      toast('error', "Recording couldn't be set up", engine.error)
    }
    watchEngine(onEngineDied).catch((e) => log.warn('Engine watch failed', e))
  }

  // Game detection: tags clips with the game and switches to game capture.
  library.setGameIcons(savedIcons())
  detector.onIcon = () => library.setGameIcons(savedIcons())
  // Show real icons for installed games right away, not only after they've been played.
  findGameIcons(allGames())
    .then((found) => found && library.setGameIcons(savedIcons()))
    .catch((e) => log.warn('Looking for game icons failed', e))
  onSettingsChange((next, prev) => {
    if (JSON.stringify(next.customGames) !== JSON.stringify(prev.customGames)) {
      findGameIcons(allGames()).then((found) => found && library.setGameIcons(savedIcons()))
    }
  })
  detector.onTick = (game) => {
    try {
      if (engine.running) capture.updateGame(game)
    } catch (e) {
      log.error('Game update failed', e)
    }
  }
  detector.start()
})

const restartedAfterCrash = process.argv.includes('--engine-restarted')
let relaunching = false

/**
 * The OBS engine stopped by itself. Everything (replay buffer, recording, sources) lives in it, so
 * the reliable fix is to restart Vibe Clip. It comes back hidden if the window was hidden, so a game
 * isn't interrupted. If it dies again right after such a restart, stop trying and say so.
 */
function onEngineDied(): void {
  if (quitting || shuttingDown) return
  engine.running = false
  engine.error = 'The recording engine stopped unexpectedly.'
  if (restartedAfterCrash && process.uptime() < 120) {
    log.error('The OBS engine stopped again right after a restart; not restarting again')
    toast('error', 'The recording engine keeps stopping', 'Clips and recording are off. Quit and reopen Vibe Clip; if it keeps happening, check the log (Settings).')
    return
  }
  log.error('Restarting Vibe Clip to bring the OBS engine back')
  const hidden = !win || !win.isVisible()
  const args = process.argv.slice(1).filter((a) => a !== '--hidden' && a !== '--engine-restarted')
  app.relaunch({ args: [...args, '--engine-restarted', ...(hidden ? ['--hidden'] : [])] })
  relaunching = true
  app.quit()
}

/** Waits until this app's obs64.exe has exited (its files can't be replaced by an update while it runs). */
async function waitForEngineExit(timeoutMs = 10000): Promise<void> {
  const dir = engineDir().replace(/'/g, "''")
  const count = () =>
    new Promise<number>((resolve) =>
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `@(Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir}*' }).Count`],
        { windowsHide: true, timeout: 5000 },
        (err, out) => resolve(err ? 0 : Number(out.trim()) || 0)
      )
    )
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if ((await count()) === 0) return
    await new Promise((r) => setTimeout(r, 400))
  }
  log.warn('The OBS engine took too long to exit')
}

let engineStopped = false
/** Stops everything cleanly: saves a running recording, stops outputs and the OBS engine. */
async function shutdownAll(): Promise<void> {
  quitting = true
  detector.stop()
  hidePreview()
  // If the engine already died there's nothing to stop (and waiting for its signals would hang).
  if (isEngineRunning()) await capture.shutdown().catch((err) => log.error('Shutdown error', err))
  capture.outputs.recordingActive = false
  capture.outputs.replayActive = false
  flushProfiles()
  unregisterHotkeys()
  if (!engineStopped) {
    stopEngine()
    engineStopped = true
  }
}

// Stop recording cleanly (so the file is saved) before the app exits. If an update was
// downloaded and you chose "Later", it installs now (quietly), like the other apps.
let shuttingDown = false
app.on('before-quit', (e) => {
  if (shuttingDown) return
  e.preventDefault()
  shuttingDown = true
  shutdownAll()
    .then(async () => {
      // (A pending update waits for a normal quit, not a restart after an engine crash.)
      if (updateReady() && !relaunching) {
        await waitForEngineExit()
        await installUpdate(true, false)
      }
    })
    .catch((err) => log.error('Shutdown error', err))
    .finally(() => app.quit())
})

// The tray keeps the app alive when the window is closed.
app.on('window-all-closed', () => {
  if (quitting || !getSettings().minimizeToTray) app.quit()
})

app.on('will-quit', () => {
  flushProfiles()
  unregisterHotkeys()
  destroyOverlay()
  destroyTray()
  if (!engineStopped) stopEngine()
  closeDb()
})
