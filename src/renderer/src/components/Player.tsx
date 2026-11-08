import { useEffect, useState } from 'react'
import { IconChevronLeft, IconChevronRight, IconCut, IconFolderOpen, IconX } from '@tabler/icons-react'
import type { Clip } from '@shared/types'
import { formatDuration, formatSize } from '../lib/format'
import { useOverlay } from '../lib/overlay'
import { VideoPlayer } from './VideoPlayer'

interface Props {
  clip: Clip
  /** The clips currently shown, so ← and → can move between them. */
  list: Clip[]
  onNavigate: (clip: Clip) => void
  onClose: () => void
  onEdit: (clip: Clip) => void
}

export function Player({ clip, list, onNavigate, onClose, onEdit }: Props) {
  const [error, setError] = useState<string | null>(null)
  useOverlay(true)
  const index = list.findIndex((c) => c.id === clip.id)
  const prev = index > 0 ? list[index - 1] : null
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null

  useEffect(() => setError(null), [clip.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && e.ctrlKey && prev) onNavigate(prev)
      else if (e.key === 'ArrowRight' && e.ctrlKey && next) onNavigate(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onClose, onNavigate])

  return (
    <div className="modal-backdrop player-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="player">
        <div className="player-head">
          <div className="player-title">
            <strong>{clip.title}</strong>
            <span className="muted">
              {clip.gameName} · {new Date(clip.createdAt).toLocaleString()} ·{' '}
              {clip.kind !== 'screenshot' && `${formatDuration(clip.duration)} · `}
              {formatSize(clip.size)}
              {clip.width > 0 && ` · ${clip.width}×${clip.height}`}
            </span>
          </div>
          {clip.kind !== 'screenshot' && (
            <button className="btn" onClick={() => onEdit(clip)}>
              <IconCut size={15} /> Edit
            </button>
          )}
          <button className="icon-btn" title="Show in folder" onClick={() => window.api.library.reveal(clip.id)}>
            <IconFolderOpen size={18} />
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>
        <div className="player-stage">
          {prev && (
            <button className="nav-btn left" title="Previous (Ctrl ←)" onClick={() => onNavigate(prev)}>
              <IconChevronLeft size={22} />
            </button>
          )}
          {error ? (
            <div className="player-error">
              <p>{error}</p>
              <button className="btn" onClick={() => window.api.library.reveal(clip.id)}>
                Show file in folder
              </button>
            </div>
          ) : clip.kind === 'screenshot' ? (
            <img src={clip.url} alt="" onError={() => setError("This screenshot couldn't be loaded. The file may have been moved or deleted.")} />
          ) : (
            <VideoPlayer key={clip.id} clip={clip} onError={setError} />
          )}
          {next && (
            <button className="nav-btn right" title="Next (Ctrl →)" onClick={() => onNavigate(next)}>
              <IconChevronRight size={22} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
