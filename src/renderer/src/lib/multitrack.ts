// Plays every audio track of a clip together with its (muted) video, each through its own
// volume control. Browsers only play a video's first audio track, so the app extracts each
// track to its own file and this keeps them in step with the video (play, pause, seek, speed).
export interface TrackMix {
  enabled: boolean
  /** 1 = 100%. Up to 2 (200%). */
  volume: number
}

export class MultiTrackAudio {
  private ctx = new AudioContext()
  private master: GainNode
  private tracks: { el: HTMLAudioElement; gain: GainNode; mix: TrackMix }[] = []
  private timer: number | null = null
  private off: (() => void)[] = []
  private failed = false
  /** Called once if a track can't be loaded, so the player can fall back to the video's own sound. */
  onFail: ((reason: string) => void) | null = null

  constructor(
    private video: HTMLVideoElement,
    urls: string[]
  ) {
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    for (const url of urls) {
      const el = new Audio()
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      el.addEventListener('error', () => {
        if (this.failed || !el.getAttribute('src')) return
        this.failed = true
        this.onFail?.(el.error?.message || `error ${el.error?.code ?? '?'}`)
      })
      el.src = url
      const gain = this.ctx.createGain()
      this.ctx.createMediaElementSource(el).connect(gain).connect(this.master)
      this.tracks.push({ el, gain, mix: { enabled: true, volume: 1 } })
    }
    const on = (ev: string, fn: () => void) => {
      video.addEventListener(ev, fn)
      this.off.push(() => video.removeEventListener(ev, fn))
    }
    on('play', () => this.play())
    on('playing', () => this.play())
    on('pause', () => this.pauseAll())
    on('waiting', () => this.pauseAll())
    on('seeking', () => this.seekAll())
    on('seeked', () => this.seekAll())
    on('ratechange', () => this.tracks.forEach((t) => (t.el.playbackRate = video.playbackRate)))
    on('ended', () => this.pauseAll())
    if (!video.paused) this.play()
  }

  private play(): void {
    if (this.video.paused) return
    void this.ctx.resume()
    for (const t of this.tracks) {
      t.el.playbackRate = this.video.playbackRate
      if (Math.abs(t.el.currentTime - this.video.currentTime) > 0.05) t.el.currentTime = this.video.currentTime
      if (t.el.paused) void t.el.play().catch(() => {})
    }
    // Small drifts add up over minutes: nudge tracks back in step a few times a second.
    if (this.timer === null)
      this.timer = window.setInterval(() => {
        if (this.video.paused) return
        for (const t of this.tracks) {
          if (Math.abs(t.el.currentTime - this.video.currentTime) > 0.08) t.el.currentTime = this.video.currentTime
        }
      }, 300)
  }

  private pauseAll(): void {
    for (const t of this.tracks) t.el.pause()
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private seekAll(): void {
    for (const t of this.tracks) t.el.currentTime = this.video.currentTime
    if (!this.video.paused) this.play()
  }

  setTrack(index: number, mix: TrackMix): void {
    const t = this.tracks[index]
    if (!t) return
    t.mix = mix
    t.gain.gain.value = mix.enabled ? Math.max(0, mix.volume) : 0
  }

  setMaster(volume: number, muted: boolean): void {
    this.master.gain.value = muted ? 0 : Math.max(0, volume)
  }

  destroy(): void {
    this.pauseAll()
    this.off.forEach((f) => f())
    for (const t of this.tracks) {
      t.el.removeAttribute('src')
      t.el.load()
    }
    void this.ctx.close()
  }
}
