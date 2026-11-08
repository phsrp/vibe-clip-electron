// Starts and stops the OBS engine (libobs, via Streamlabs' obs-studio-node).
// obs-studio-node runs OBS in a helper process (obs64.exe) and talks to it over a pipe,
// so an OBS crash can't take the whole app down with it.
import * as osn from 'obs-studio-node'
import * as path from 'path'
import { execFile } from 'child_process'
import { app } from 'electron'
import { createLogger } from '../logger'
import { InitCode } from './constants'

const log = createLogger('engine')

let started = false

export function engineDir(): string {
  // Folder containing obs64.exe, the OBS plugins, ffmpeg.exe and ffprobe.exe.
  const dir = path.dirname(require.resolve('obs-studio-node'))
  // When packaged, native files live outside the asar archive.
  return dir.replace('app.asar', 'app.asar.unpacked')
}

export function startEngine(): void {
  if (started) return
  const dataPath = path.join(app.getPath('userData'), 'obs-data')
  const pipe = `vibe-clip-${process.pid}-${Date.now()}`
  log.info(`Starting OBS engine from ${engineDir()}`)

  const hostResult = osn.NodeObs.IPC.host(pipe) as unknown as number
  if (hostResult !== 0) {
    throw new Error(
      hostResult === 253
        ? 'Could not start obs64.exe (missing file or blocked by antivirus).'
        : hostResult === 254
          ? 'The OBS engine is missing a dependency (try reinstalling the Visual C++ runtime).'
          : `The OBS engine helper failed to start (code ${hostResult}).`
    )
  }
  osn.NodeObs.SetWorkingDirectory(engineDir())

  const result = osn.NodeObs.OBS_API_initAPI({
    language: 'en-US',
    appDataPath: dataPath,
    version: app.getVersion(),
    crashServerUrl: ''
  }) as unknown as number

  if (result !== 0) {
    try {
      osn.NodeObs.IPC.disconnect()
    } catch {
      /* ignore */
    }
    throw new Error(InitCode[result] ?? `OBS engine failed to start (code ${result}).`)
  }
  started = true
  log.info('OBS engine started')
}

// ----- Watching the engine -----
// If obs64.exe dies (crash, killed, antivirus), every call into it fails with "Failed to make IPC
// call". The watcher notices within a few seconds so the app can restart itself instead.

let watchTimer: NodeJS.Timeout | null = null

/** Finds this app's own obs64.exe (a child of the main process), so it can be watched. */
function findEnginePid(): Promise<number | null> {
  return new Promise((resolve) =>
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='obs64.exe'" | Select-Object -First 1).ProcessId`],
      { windowsHide: true, timeout: 15000 },
      (err, out) => resolve(err ? null : Number(out.trim()) || null)
    )
  )
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 only checks that the process exists
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Calls onDeath once if the engine process stops while the app still needs it. */
export async function watchEngine(onDeath: () => void): Promise<void> {
  const pid = await findEnginePid()
  if (!pid) {
    log.warn("Couldn't find the OBS engine process, so it won't be watched")
    return
  }
  log.info(`Watching the OBS engine (process ${pid})`)
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = setInterval(() => {
    if (!started) return
    if (isAlive(pid)) return
    clearInterval(watchTimer!)
    watchTimer = null
    // Nothing to disconnect from any more: calls into it would only fail.
    started = false
    log.error(`The OBS engine (process ${pid}) stopped unexpectedly`)
    onDeath()
  }, 2000)
}

export function stopEngine(): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
  if (!started) return
  log.info('Stopping OBS engine')
  try {
    osn.NodeObs.OBS_service_removeCallback()
  } catch (e) {
    log.warn('removeCallback failed', e)
  }
  try {
    osn.NodeObs.IPC.disconnect()
  } catch (e) {
    log.warn('IPC disconnect failed', e)
  }
  started = false
}

export function isEngineRunning(): boolean {
  return started
}

export { osn }
