// Clip editor: trim, split, remove parts, change each part's speed, crop, and adjust every audio
// track (keep/drop, listen, volume, fades), then export a new clip.
// Simplified from the Vibe Video Editor's timeline (same ruler / playhead / trim-handle style).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCrop,
  IconDeviceFloppy,
  IconHeadphones,
  IconHeadphonesOff,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRestore,
  IconScissors,
  IconTrash,
  IconX,
  IconZoomIn
} from '@tabler/icons-react'
import type { AudioTrackInfo, Clip, CropRect, EditAudio, EditSegment, EditStrip, EditTrack } from '@shared/types'
import { MultiTrackAudio } from '../lib/multitrack'
import { mixFor } from '../lib/trackPrefs'

interface EditState {
  segments: EditSegment[]
  crop: CropRect | null
  audio: EditAudio
}

const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16 (vertical)', ratio: 9 / 16 },
  { id: '1:1', label: '1:1 (square)', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 }
]

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

function fmt(t: number, precise = true): string {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return precise ? `${m}:${sec.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`
}

const sp = (s: EditSegment) => s.speed || 1
const partLength = (s: EditSegment) => (s.end - s.start) / sp(s)

export function EditorPage({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const engine = useRef<MultiTrackAudio | null>(null)
  const [strip, setStrip] = useState<EditStrip | null>(null)
  const [trackInfo, setTrackInfo] = useState<AudioTrackInfo[]>([])
  const [edit, setEdit] = useState<EditState>({ segments: [], crop: null, audio: { tracks: [], fadeIn: 0, fadeOut: 0, mix: false } })
  const [past, setPast] = useState<EditState[]>([])
  const [future, setFuture] = useState<EditState[]>([])
  const [selected, setSelected] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(1) // 1 = fit the whole clip
  const [cropMode, setCropMode] = useState(false)
  const [aspect, setAspect] = useState('free')
  const [progress, setProgress] = useState<number | null>(null)
  const duration = strip?.duration ?? clip.duration

  useEffect(() => {
    setStrip(null)
    setTrackInfo([])
    let alive = true
    Promise.all([window.api.editor.strip(clip.id), window.api.media.audioTracks(clip.id)]).then(([s, t]) => {
      if (!alive || !s) return
      const info = t ?? []
      setStrip(s)
      setTrackInfo(info)
      // Start with: every track that has sound kept, and the same tracks you listen to in the player.
      const listen = mixFor(info)
      const tracks: EditTrack[] = info.map((x, i) => ({ keep: !x.silent, listen: listen[i]?.enabled ?? true, volume: 1 }))
      setEdit({ segments: [{ start: 0, end: s.duration, speed: 1 }], crop: null, audio: { tracks, fadeIn: 0, fadeOut: 0, mix: false } })
      setPast([])
      setFuture([])
      setSelected(0)
    })
    return () => {
      alive = false
    }
  }, [clip.id])

  // Play every audio track alongside the (muted) video.
  useEffect(() => {
    const v = videoRef.current
    if (!v || trackInfo.length === 0) return
    v.muted = true
    const e = new MultiTrackAudio(v, trackInfo.map((t) => t.url))
    // If the separate tracks can't play, preview with the video's own sound rather than silence.
    e.onFail = (reason) => {
      console.warn(`Separate audio tracks failed (${reason}); using the video's own sound`)
      if (engine.current === e) engine.current = null
      e.destroy()
      v.muted = false
    }
    engine.current = e
    return () => {
      e.destroy()
      engine.current = null
    }
  }, [trackInfo])
  useEffect(() => {
    edit.audio.tracks.forEach((t, i) => engine.current?.setTrack(i, { enabled: t.listen, volume: t.volume }))
  }, [edit.audio.tracks, trackInfo])

  useEffect(() => window.api.editor.onProgress((p) => setProgress(p)), [])

  /** Every change goes through here so it can be undone. */
  const commit = useCallback((next: EditState) => {
    setEdit((prev) => {
      setPast((p) => [...p.slice(-99), prev])
      setFuture([])
      return next
    })
  }, [])
  const undo = () => {
    if (!past.length) return
    setFuture((f) => [edit, ...f])
    setEdit(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }
  const redo = () => {
    if (!future.length) return
    setPast((p) => [...p, edit])
    setEdit(future[0])
    setFuture((f) => f.slice(1))
  }
  const setTrack = (i: number, patch: Partial<EditTrack>, done = true) => {
    const next = { ...edit, audio: { ...edit.audio, tracks: edit.audio.tracks.map((t, j) => (j === i ? { ...t, ...patch } : t)) } }
    if (done) commit(next)
    else setEdit(next)
  }

  // ----- Playback that skips removed parts and plays each part at its speed -----
  const seek = (t: number) => {
    const v = videoRef.current
    const c = Math.max(0, Math.min(duration, t))
    if (v) v.currentTime = c
    setTime(c)
  }
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const v = videoRef.current
      if (v) {
        const t = v.currentTime
        const segs = edit.segments
        const inside = segs.find((s) => t >= s.start - 0.01 && t < s.end)
        if (!inside) {
          const next = segs.find((s) => s.start > t)
          if (next) v.currentTime = next.start
          else {
            v.pause()
            setPlaying(false)
          }
        } else if (Math.abs(v.playbackRate - sp(inside)) > 0.001) {
          v.playbackRate = sp(inside)
        }
        setTime(v.currentTime)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, edit.segments])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      const segs = edit.segments
      const last = segs[segs.length - 1]
      if (!last) return
      if (time >= last.end - 0.05 || !segs.some((s) => time >= s.start && time < s.end)) {
        const next = segs.find((s) => s.start >= time) ?? segs[0]
        v.currentTime = next.start
      }
      const cur = segs.find((s) => v.currentTime >= s.start - 0.01 && v.currentTime < s.end)
      v.playbackRate = cur ? sp(cur) : 1
      void v.play()
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  // ----- Editing actions -----
  const split = () => {
    const i = edit.segments.findIndex((s) => time > s.start + 0.05 && time < s.end - 0.05)
    if (i < 0) return
    const s = edit.segments[i]
    const segments = [...edit.segments.slice(0, i), { ...s, end: time }, { ...s, start: time }, ...edit.segments.slice(i + 1)]
    commit({ ...edit, segments })
    setSelected(i + 1)
  }
  const removeSelected = () => {
    if (edit.segments.length <= 1) return
    const segments = edit.segments.filter((_, i) => i !== selected)
    commit({ ...edit, segments })
    setSelected(Math.max(0, selected - 1))
  }
  const setSpeed = (speed: number, all: boolean) =>
    commit({ ...edit, segments: edit.segments.map((s, i) => (all || i === selected ? { ...s, speed } : s)) })
  const reset = () =>
    commit({
      segments: [{ start: 0, end: duration, speed: 1 }],
      crop: null,
      audio: { ...edit.audio, fadeIn: 0, fadeOut: 0, mix: false, tracks: edit.audio.tracks.map((t, i) => ({ ...t, keep: !trackInfo[i]?.silent, volume: 1 })) }
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 's' && !e.ctrlKey) split()
      else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected()
      else if (e.key.toLowerCase() === 'c' && !e.ctrlKey) setCropMode((c) => !c)
      else if (e.ctrlKey && e.key.toLowerCase() === 'z') (e.shiftKey ? redo : undo)()
      else if (e.ctrlKey && e.key.toLowerCase() === 'y') redo()
      else if (e.key === 'ArrowLeft') seek(time - (e.shiftKey ? 1 : 1 / 60))
      else if (e.key === 'ArrowRight') seek(time + (e.shiftKey ? 1 : 1 / 60))
      else if (e.key === 'Escape') setCropMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const kept = edit.segments.reduce((t, s) => t + partLength(s), 0)
  const keptTracks = edit.audio.tracks.filter((t) => t.keep).length
  const selSeg = edit.segments[selected]

  const doExport = async () => {
    setProgress(0)
    videoRef.current?.pause()
    setPlaying(false)
    const id = await window.api.editor.export({ clipId: clip.id, segments: edit.segments, crop: edit.crop, audio: edit.audio })
    setProgress(null)
    if (id) onClose()
  }

  return (
    <div className="page editor-page">
      <div className="editor-head">
        <div className="editor-title">
          <strong>{clip.title}</strong>
          <span className="muted">
            {clip.gameName} · keeps {fmt(kept, false)} of {fmt(duration, false)}
            {edit.crop ? ` · cropped to ${Math.round(edit.crop.width)}×${Math.round(edit.crop.height)}` : ''}
            {trackInfo.length > 0 ? ` · ${keptTracks} of ${trackInfo.length} audio track${trackInfo.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <button className="btn" onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">
          <IconArrowBackUp size={15} />
        </button>
        <button className="btn" onClick={redo} disabled={!future.length} title="Redo (Ctrl+Y)">
          <IconArrowForwardUp size={15} />
        </button>
        <button className="btn" onClick={reset} title="Undo all edits">
          <IconRestore size={15} /> Reset
        </button>
        {keptTracks > 1 && (
          <select
            className="select"
            value={edit.audio.mix ? 'mix' : 'separate'}
            onChange={(e) => commit({ ...edit, audio: { ...edit.audio, mix: e.target.value === 'mix' } })}
            title="How the kept audio tracks are saved"
          >
            <option value="separate">Keep tracks separate</option>
            <option value="mix">Mix into one track</option>
          </select>
        )}
        {progress === null ? (
          <button className="btn btn-accent" onClick={doExport} disabled={!strip || !edit.segments.length}>
            <IconDeviceFloppy size={15} /> Save as new clip
          </button>
        ) : (
          <div className="export-progress">
            <div className="bar">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span>{Math.round(progress * 100)}%</span>
            <button className="btn" onClick={() => window.api.editor.cancel()}>
              Cancel
            </button>
          </div>
        )}
        <button className="icon-btn" onClick={onClose} title="Close editor">
          <IconX size={18} />
        </button>
      </div>

      <div className="editor-stage">
        <video
          ref={videoRef}
          src={clip.url}
          onLoadedMetadata={() => seek(0)}
          onPause={() => setPlaying(false)}
          onClick={togglePlay}
        />
        {cropMode && strip && (
          <CropOverlay
            video={videoRef}
            source={{ width: strip.width, height: strip.height }}
            crop={edit.crop ?? { x: 0, y: 0, width: strip.width, height: strip.height }}
            ratio={ASPECTS.find((a) => a.id === aspect)?.ratio ?? null}
            onChange={(crop, done) => (done ? commit({ ...edit, crop }) : setEdit((e) => ({ ...e, crop })))}
          />
        )}
      </div>

      <div className="editor-tools">
        <button className="icon-btn big" onClick={togglePlay} title="Play / pause (Space)">
          {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
        </button>
        <span className="timecode">
          {fmt(time)} <span className="muted">/ {fmt(duration)}</span>
        </span>
        <div className="tool-sep" />
        <button className="btn" onClick={split} title="Split at the playhead (S)">
          <IconScissors size={15} /> Split
        </button>
        <button className="btn" onClick={removeSelected} disabled={edit.segments.length <= 1} title="Remove the selected part (Delete)">
          <IconTrash size={15} /> Remove part
        </button>
        <div className="tool-sep" />
        <span className="tool-label">Speed</span>
        <select className="select narrow" value={selSeg ? sp(selSeg) : 1} onChange={(e) => setSpeed(Number(e.target.value), false)} title="Speed of the selected part">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        {edit.segments.length > 1 && (
          <button className="btn ghost" onClick={() => selSeg && setSpeed(sp(selSeg), true)} title="Use this speed for every part">
            All parts
          </button>
        )}
        <div className="tool-sep" />
        <button className={'btn' + (cropMode ? ' btn-accent' : '')} onClick={() => setCropMode(!cropMode)} title="Crop (C)">
          <IconCrop size={15} /> Crop
        </button>
        {cropMode && (
          <>
            <select
              className="select"
              value={aspect}
              onChange={(e) => {
                setAspect(e.target.value)
                const r = ASPECTS.find((a) => a.id === e.target.value)?.ratio
                if (r && strip) {
                  // Biggest centred box with that shape.
                  let w = strip.width
                  let h = w / r
                  if (h > strip.height) {
                    h = strip.height
                    w = h * r
                  }
                  commit({ ...edit, crop: { x: (strip.width - w) / 2, y: (strip.height - h) / 2, width: w, height: h } })
                }
              }}
            >
              {ASPECTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <button className="btn ghost" onClick={() => commit({ ...edit, crop: null })} disabled={!edit.crop}>
              Remove crop
            </button>
          </>
        )}
        <div className="spacer" />
        <IconZoomIn size={15} className="muted" />
        <input type="range" className="range small" min={1} max={20} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="Zoom the timeline" />
      </div>

      {strip ? (
        <Timeline
          duration={duration}
          strip={strip}
          segments={edit.segments}
          selected={selected}
          time={time}
          zoom={zoom}
          trackInfo={trackInfo}
          audio={edit.audio}
          onAudio={(audio, done) => (done ? commit({ ...edit, audio }) : setEdit((e) => ({ ...e, audio })))}
          onTrack={setTrack}
          onSelect={setSelected}
          onSeek={seek}
          onTrim={(segments, done) => (done ? commit({ ...edit, segments }) : setEdit((e) => ({ ...e, segments })))}
        />
      ) : (
        <div className="timeline loading">Preparing the timeline…</div>
      )}
      <p className="editor-help">
        Drag the ends of a part to trim it. <kbd>S</kbd> splits at the playhead, <kbd>Delete</kbd> removes the selected part, <kbd>C</kbd> crops,{' '}
        <kbd>Space</kbd> plays, <kbd>←</kbd>/<kbd>→</kbd> step one frame. The original clip is never changed.
      </p>
    </div>
  )
}

// ---------------- Timeline ----------------

/** A small number box that saves on Enter, when you click away, or half a second after you stop typing. */
function SmallNum({ value, onChange, max }: { value: number; onChange: (v: number) => void; max: number }) {
  const [text, setText] = useState(String(value))
  const timer = useRef(0)
  useEffect(() => setText(String(value)), [value])
  const commit = (raw: string) => {
    clearTimeout(timer.current)
    const n = Math.min(max, Math.max(0, Number(raw)))
    if (raw.trim() !== '' && Number.isFinite(n) && n !== value) onChange(Math.round(n * 10) / 10)
  }
  return (
    <input
      className="small-num"
      value={text}
      onChange={(e) => {
        const v = e.target.value
        setText(v)
        clearTimeout(timer.current)
        timer.current = window.setTimeout(() => commit(v), 500)
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
    />
  )
}

function Timeline(p: {
  duration: number
  strip: EditStrip
  segments: EditSegment[]
  selected: number
  time: number
  zoom: number
  trackInfo: AudioTrackInfo[]
  audio: EditAudio
  onAudio: (a: EditAudio, done: boolean) => void
  onTrack: (i: number, patch: Partial<EditTrack>, done?: boolean) => void
  onSelect: (i: number) => void
  onSeek: (t: number) => void
  onTrim: (segments: EditSegment[], done: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const PAD = 16
  const pxPerSec = ((width - PAD * 2) / Math.max(p.duration, 0.1)) * p.zoom
  const total = p.duration * pxPerSec
  const x = (t: number) => PAD + t * pxPerSec
  const tAt = (clientX: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(p.duration, (clientX - r.left + el.scrollLeft - PAD) / pxPerSec))
  }

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || p.zoom <= 1) return
    const px = x(p.time)
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = px - el.clientWidth / 2
  }, [p.time])

  const ticks = useMemo(() => {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
    const step = steps.find((s) => s * pxPerSec >= 70) ?? 600
    const out: number[] = []
    for (let t = 0; t <= p.duration + 0.001; t += step) out.push(t)
    return out
  }, [pxPerSec, p.duration])

  const scrub = (e: React.PointerEvent) => {
    p.onSeek(tAt(e.clientX))
    const move = (ev: PointerEvent) => p.onSeek(tAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startTrim = (e: React.PointerEvent, i: number, edge: 'start' | 'end') => {
    e.stopPropagation()
    p.onSelect(i)
    const segs = p.segments
    const min = edge === 'start' ? (i > 0 ? segs[i - 1].end : 0) : segs[i].start + 0.1
    const max = edge === 'start' ? segs[i].end - 0.1 : i < segs.length - 1 ? segs[i + 1].start : p.duration
    let latest = segs
    const move = (ev: PointerEvent) => {
      const t = Math.max(min, Math.min(max, tAt(ev.clientX)))
      latest = segs.map((s, j) => (j === i ? { ...s, [edge]: t } : s))
      p.onTrim(latest, false)
      p.onSeek(t)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      p.onTrim(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const stripStyle = { backgroundImage: `url("${p.strip.strip}")`, backgroundSize: `${total}px 100%` }
  const hasAudio = p.trackInfo.length > 0

  return (
    <div className="timeline">
      <div className="tl-heads">
        <div className="tl-head ruler-head" />
        <div className="tl-head video-head">Video</div>
        {hasAudio && (
          <div className="tl-head fades-head">
            <span>Fade in</span>
            <SmallNum value={p.audio.fadeIn} max={30} onChange={(fadeIn) => p.onAudio({ ...p.audio, fadeIn }, true)} />
            <span>out</span>
            <SmallNum value={p.audio.fadeOut} max={30} onChange={(fadeOut) => p.onAudio({ ...p.audio, fadeOut }, true)} />
            <span className="muted">s</span>
          </div>
        )}
        {p.trackInfo.map((t, i) => {
          const tr = p.audio.tracks[i] ?? { keep: true, listen: true, volume: 1 }
          return (
            <div key={t.index} className={'tl-head track-head' + (tr.keep ? '' : ' dropped')}>
              <label className="track-keep" title={tr.keep ? 'In the export (click to leave it out)' : 'Left out of the export (click to include)'}>
                <input type="checkbox" checked={tr.keep} onChange={(e) => p.onTrack(i, { keep: e.target.checked })} />
                <b>{i + 1}</b>
                <span className="track-title">{t.name}</span>
              </label>
              <button
                className={'icon-btn small' + (tr.listen ? ' on' : '')}
                title={tr.listen ? 'Listening (click to stop hearing it while editing)' : 'Not listening (click to hear it while editing)'}
                onClick={() => p.onTrack(i, { listen: !tr.listen })}
              >
                {tr.listen ? <IconHeadphones size={14} /> : <IconHeadphonesOff size={14} />}
              </button>
              <input
                type="range"
                className="range track-vol"
                min={0}
                max={2}
                step={0.01}
                value={tr.volume}
                onChange={(e) => p.onTrack(i, { volume: Number(e.target.value) }, false)}
                onMouseUp={(e) => p.onTrack(i, { volume: Number((e.target as HTMLInputElement).value) }, true)}
                onDoubleClick={() => p.onTrack(i, { volume: 1 })}
                title="Volume (double-click for 100%)"
              />
              <span className="track-pct">{Math.round(tr.volume * 100)}%</span>
            </div>
          )
        })}
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width: total + PAD * 2 }}>
          <div className="tl-ruler" onPointerDown={scrub}>
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: x(t) }}>
                {/* Half-second steps need the decimal, or labels repeat (0:00, 0:00, 0:01...). */}
                {ticks.length > 1 && ticks[1] - ticks[0] < 1 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : fmt(t, false)}
              </span>
            ))}
          </div>
          <div className="tl-lane" onPointerDown={scrub}>
            <div className="tl-ghost" style={{ left: PAD, width: total, ...stripStyle }} />
            {p.segments.map((s, i) => (
              <div
                key={i}
                className={'tl-seg' + (i === p.selected ? ' selected' : '')}
                style={{ left: x(s.start), width: Math.max(2, (s.end - s.start) * pxPerSec), ...stripStyle, backgroundPosition: `${-s.start * pxPerSec}px 0` }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  p.onSelect(i)
                  scrub(e)
                }}
              >
                <span className="seg-label">
                  {fmt(partLength(s), false)}
                  {sp(s) !== 1 && <b className="seg-speed"> {sp(s)}×</b>}
                </span>
                <span className="tl-handle left" onPointerDown={(e) => startTrim(e, i, 'start')} />
                <span className="tl-handle right" onPointerDown={(e) => startTrim(e, i, 'end')} />
              </div>
            ))}
          </div>
          {hasAudio && <div className="tl-fades-row" onPointerDown={scrub} />}
          {p.trackInfo.map((t, i) => {
            const tr = p.audio.tracks[i]
            const wave = p.strip.waves[i]
            return (
              <div key={t.index} className={'tl-wave' + (tr && !tr.keep ? ' dropped' : '')} onPointerDown={scrub}>
                {wave && <img src={wave} style={{ left: PAD, width: total }} alt="" draggable={false} />}
                {t.silent && <span className="wave-silent" style={{ left: PAD + 6 }}>silent</span>}
                {p.segments.map((s, k) => (
                  <span key={k} className="wave-keep" style={{ left: x(s.start), width: (s.end - s.start) * pxPerSec }} />
                ))}
              </div>
            )
          })}
          <div className="tl-playhead" style={{ left: x(p.time) }}>
            <span className="knob" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------- Crop overlay ----------------

type Drag = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

function CropOverlay(p: {
  video: React.RefObject<HTMLVideoElement | null>
  source: { width: number; height: number }
  crop: CropRect
  ratio: number | null
  onChange: (crop: CropRect, done: boolean) => void
}) {
  const [box, setBox] = useState({ left: 0, top: 0, width: 1, height: 1 })
  useEffect(() => {
    const v = p.video.current
    if (!v) return
    const update = () => {
      // Where the picture actually is inside the <video> element (it's letterboxed).
      const r = v.getBoundingClientRect()
      const parent = v.parentElement!.getBoundingClientRect()
      const scale = Math.min(r.width / p.source.width, r.height / p.source.height)
      const w = p.source.width * scale
      const h = p.source.height * scale
      setBox({ left: r.left - parent.left + (r.width - w) / 2, top: r.top - parent.top + (r.height - h) / 2, width: w, height: h })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(v)
    return () => ro.disconnect()
  }, [p.source.width, p.source.height])

  const s = box.width / p.source.width
  const c = p.crop

  const start = (e: React.PointerEvent, mode: Drag) => {
    e.stopPropagation()
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const orig = { ...c }
    let latest = orig
    const W = p.source.width
    const H = p.source.height
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s
      const dy = (ev.clientY - y0) / s
      let { x, y, width, height } = orig
      if (mode === 'move') {
        x = Math.max(0, Math.min(W - width, orig.x + dx))
        y = Math.max(0, Math.min(H - height, orig.y + dy))
      } else {
        if (mode.includes('e')) width = Math.max(32, Math.min(W - x, orig.width + dx))
        if (mode.includes('s')) height = Math.max(32, Math.min(H - y, orig.height + dy))
        if (mode.includes('w')) {
          const nx = Math.max(0, Math.min(orig.x + orig.width - 32, orig.x + dx))
          width = orig.width + (orig.x - nx)
          x = nx
        }
        if (mode.includes('n')) {
          const ny = Math.max(0, Math.min(orig.y + orig.height - 32, orig.y + dy))
          height = orig.height + (orig.y - ny)
          y = ny
        }
        if (p.ratio) {
          // Keep the chosen shape: follow the dragged side, fit inside the picture.
          if (mode === 'n' || mode === 's') width = height * p.ratio
          else height = width / p.ratio
          if (x + width > W) {
            width = W - x
            height = width / p.ratio
          }
          if (y + height > H) {
            height = H - y
            width = height * p.ratio
          }
          if (mode.includes('n')) y = orig.y + orig.height - height
          if (mode.includes('w')) x = orig.x + orig.width - width
        }
      }
      latest = { x, y, width, height }
      p.onChange(latest, false)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      p.onChange(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handles: Drag[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  return (
    <div className="crop-layer" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <div className="crop-box" style={{ left: c.x * s, top: c.y * s, width: c.width * s, height: c.height * s }} onPointerDown={(e) => start(e, 'move')}>
        <span className="crop-grid" />
        {handles.map((h) => (
          <span key={h} className={`crop-h ${h}`} onPointerDown={(e) => start(e, h)} />
        ))}
        <span className="crop-size">
          {Math.round(c.width)}×{Math.round(c.height)}
        </span>
      </div>
    </div>
  )
}
