// The clip player: a video with custom controls and a track mixer, so you can hear every
// audio track (desktop, mic...), not just the first one.
import { useEffect, useRef, useState } from 'react'
import {
  IconAdjustmentsHorizontal,
  IconMaximize,
  IconMinimize,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerTrackNextFilled,
  IconPlayerTrackPrevFilled,
  IconVolume,
  IconVolume3
} from '@tabler/icons-react'
import type { AudioTrackInfo, Clip } from '@shared/types'
import { MultiTrackAudio, type TrackMix } from '../lib/multitrack'
import { loadPrefs, mixFor, savePrefs, defaultMix } from '../lib/trackPrefs'
import { formatDuration } from '../lib/format'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function fmt(t: number): string {
  if (!Number.isFinite(t)) return '0:00'
  return formatDuration(Math.floor(t))
}

export function VideoPlayer({ clip, onError }: { clip: Clip; onError: (msg: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const engine = useRef<MultiTrackAudio | null>(null)
  const [tracks, setTracks] = useState<AudioTrackInfo[]>([])
  const [mix, setMix] = useState<TrackMix[]>([])
  const saved = loadPrefs()
  const [master, setMaster] = useState(saved?.master ?? 1)
  const [muted, setMuted] = useState(saved?.muted ?? false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(clip.duration)
  const [rate, setRate] = useState(1)
  const [panel, setPanel] = useState<'tracks' | 'speed' | null>(null)
  const [full, setFull] = useState(false)
  const [idle, setIdle] = useState(false)
  const [scrub, setScrub] = useState<number | null>(null)

  // Load the separate audio tracks; until they're ready (or if there are none) the video plays its own sound.
  useEffect(() => {
    let alive = true
    setTracks([])
    window.api.media.audioTracks(clip.id).then((t) => {
      const v = videoRef.current
      if (!alive || !t || !v || t.length === 0) return
      setTracks(t)
      const m = mixFor(t)
      setMix(m)
      v.muted = true
      const e = new MultiTrackAudio(v, t.map((x) => x.url))
      // If the separate tracks can't play, go back to the video's own sound rather than silence.
      e.onFail = (reason) => {
        console.warn(`Separate audio tracks failed (${reason}); using the video's own sound`)
        if (engine.current === e) engine.current = null
        e.destroy()
        setTracks([])
        v.muted = muted
        v.volume = Math.min(1, master)
      }
      m.forEach((x, i) => e.setTrack(i, x))
      e.setMaster(master, muted)
      engine.current = e
    })
    return () => {
      alive = false
      engine.current?.destroy()
      engine.current = null
    }
  }, [clip.id])

  // Remember your mix and volume.
  useEffect(() => {
    if (mix.length) savePrefs({ tracks: mix, master, muted })
    engine.current?.setMaster(master, muted)
    const v = videoRef.current
    if (v && !engine.current) {
      v.volume = Math.min(1, master)
      v.muted = muted
    }
  }, [mix, master, muted])

  const setTrack = (i: number, patch: Partial<TrackMix>) => {
    const next = mix.map((m, j) => (j === i ? { ...m, ...patch } : m))
    setMix(next)
    engine.current?.setTrack(i, next[i])
  }

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }
  const seekBy = (d: number) => {
    const v = videoRef.current
    if (v) v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d))
  }

  // Keyboard: Space play/pause, ←/→ 5 s, , . one frame, M mute, F fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.ctrlKey) return
      if (e.key === ' ' || e.key.toLowerCase() === 'k') (e.preventDefault(), toggle())
      else if (e.key === 'ArrowLeft') seekBy(-5)
      else if (e.key === 'ArrowRight') seekBy(5)
      else if (e.key === ',') (videoRef.current?.pause(), seekBy(-1 / 60))
      else if (e.key === '.') (videoRef.current?.pause(), seekBy(1 / 60))
      else if (e.key.toLowerCase() === 'm') setMuted((m) => !m)
      else if (e.key.toLowerCase() === 'f') toggleFull()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapRef.current?.requestFullscreen()
  }
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', f)
    return () => document.removeEventListener('fullscreenchange', f)
  }, [])

  // Hide the controls while the mouse rests on a playing video.
  const idleTimer = useRef(0)
  const wake = () => {
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setIdle(true), 2200)
  }

  const shown = scrub ?? time
  const pct = duration ? (shown / duration) * 100 : 0
  const audible = tracks.filter((_, i) => mix[i]?.enabled).length

  return (
    <div ref={wrapRef} className={'vplayer' + (idle && playing && !panel ? ' idle' : '')} onMouseMove={wake} onMouseLeave={() => setIdle(true)}>
      <video
        key={clip.id}
        ref={videoRef}
        src={clip.url}
        autoPlay
        onClick={toggle}
        onDoubleClick={toggleFull}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
        onError={() =>
          onError("This video can't be played here. The file may have been moved or deleted, or it uses a format the built-in player doesn't support.")
        }
      />

      {panel === 'tracks' && (
        <div className="vp-panel tracks-panel" onMouseDown={(e) => e.stopPropagation()}>
          <div className="vp-panel-head">
            <strong>Audio tracks</strong>
            <button className="btn ghost small" onClick={() => {
              const d = defaultMix(tracks)
              setMix(d)
              d.forEach((m, i) => engine.current?.setTrack(i, m))
            }}>
              Reset
            </button>
          </div>
          {tracks.length === 0 && <p className="muted small">This clip has one audio track (or none).</p>}
          {tracks.map((t, i) => (
            <div key={t.index} className={'vp-track' + (mix[i]?.enabled ? ' on' : '')}>
              <label className="vp-track-name">
                <input type="checkbox" checked={!!mix[i]?.enabled} onChange={(e) => setTrack(i, { enabled: e.target.checked })} />
                <b>{i + 1}</b>
                <span>{t.name}</span>
                {t.silent && <span className="tag">silent</span>}
              </label>
              <input
                type="range"
                className="range"
                min={0}
                max={2}
                step={0.01}
                value={mix[i]?.volume ?? 1}
                disabled={!mix[i]?.enabled}
                onChange={(e) => setTrack(i, { volume: Number(e.target.value) })}
                onDoubleClick={() => setTrack(i, { volume: 1 })}
                title="Double-click for 100%"
              />
              <span className="vp-pct">{Math.round((mix[i]?.volume ?? 1) * 100)}%</span>
            </div>
          ))}
          <p className="muted small">Your choice is remembered for every clip.</p>
        </div>
      )}
      {panel === 'speed' && (
        <div className="vp-panel speed-panel" onMouseDown={(e) => e.stopPropagation()}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={'vp-speed' + (s === rate ? ' on' : '')}
              onClick={() => {
                if (videoRef.current) videoRef.current.playbackRate = s
                setPanel(null)
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      )}

      <div className="vp-controls" onMouseDown={(e) => e.stopPropagation()}>
        <div
          className="vp-seek"
          onPointerDown={(e) => {
            const bar = e.currentTarget.getBoundingClientRect()
            const at = (x: number) => Math.max(0, Math.min(duration, ((x - bar.left) / bar.width) * duration))
            setScrub(at(e.clientX))
            const move = (ev: PointerEvent) => setScrub(at(ev.clientX))
            const up = (ev: PointerEvent) => {
              const v = videoRef.current
              if (v) v.currentTime = at(ev.clientX)
              setScrub(null)
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        >
          <div className="vp-seek-fill" style={{ width: `${pct}%` }} />
          <div className="vp-seek-knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="vp-row">
          <button className="vp-btn" onClick={() => (videoRef.current?.pause(), seekBy(-1 / 60))} title="Previous frame (,)">
            <IconPlayerTrackPrevFilled size={15} />
          </button>
          <button className="vp-btn big" onClick={toggle} title="Play / pause (Space)">
            {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
          </button>
          <button className="vp-btn" onClick={() => (videoRef.current?.pause(), seekBy(1 / 60))} title="Next frame (.)">
            <IconPlayerTrackNextFilled size={15} />
          </button>
          <span className="vp-time">
            {fmt(shown)} <span className="muted">/ {fmt(duration)}</span>
          </span>
          <span className="spacer" />
          <button className="vp-btn" onClick={() => setMuted(!muted)} title="Mute (M)">
            {muted || master === 0 ? <IconVolume3 size={18} /> : <IconVolume size={18} />}
          </button>
          <input type="range" className="range vp-volume" min={0} max={1} step={0.01} value={muted ? 0 : Math.min(1, master)} onChange={(e) => (setMaster(Number(e.target.value)), setMuted(false))} />
          <button className={'vp-btn text' + (panel === 'speed' ? ' on' : '')} onClick={() => setPanel(panel === 'speed' ? null : 'speed')} title="Speed">
            {rate}×
          </button>
          <button
            className={'vp-btn text' + (panel === 'tracks' ? ' on' : '')}
            onClick={() => setPanel(panel === 'tracks' ? null : 'tracks')}
            title="Choose which audio tracks you hear"
          >
            <IconAdjustmentsHorizontal size={16} /> {tracks.length > 1 ? `${audible}/${tracks.length} tracks` : 'Audio'}
          </button>
          <button className="vp-btn" onClick={toggleFull} title="Fullscreen (F)">
            {full ? <IconMinimize size={17} /> : <IconMaximize size={17} />}
          </button>
        </div>
      </div>
    </div>
  )
}
