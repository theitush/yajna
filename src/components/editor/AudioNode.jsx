import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import useAppStore from '../../store/useAppStore'
import TranscriptModal from './TranscriptModal'

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function AudioNodeView({ node, editor, getPos }) {
  const audioId = node.attrs.audioId
  const getAudioRecord = useAppStore(s => s.getAudioRecord)
  const audioRef = useRef(null)
  const [objectUrl, setObjectUrl] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(node.attrs.duration || 0)
  const [currentTime, setCurrentTime] = useState(0)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const pendingPlayRef = useRef(false)

  const loadBlob = async () => {
    setStatus('loading')
    setError(null)
    try {
      const rec = await getAudioRecord(audioId)
      if (!rec?.blob) {
        setStatus('error')
        setError('Audio not found')
        return null
      }
      const url = URL.createObjectURL(rec.blob)
      setObjectUrl(url)
      setStatus('ready')
      if (rec.duration) setDuration(rec.duration)
      return url
    } catch (e) {
      console.error('Audio load failed', e)
      setStatus('error')
      setError('Could not load audio')
      return null
    }
  }

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  const tryAutoplay = () => {
    if (!pendingPlayRef.current) return
    const el = audioRef.current
    if (!el) return
    pendingPlayRef.current = false
    el.play().catch(e => {
      console.error(e)
      setError('Playback failed')
    })
  }

  const togglePlay = async () => {
    const el = audioRef.current
    if (!objectUrl) {
      pendingPlayRef.current = true
      await loadBlob()
      // tryAutoplay fires via onCanPlay once the element mounts
      return
    }
    if (!el) return
    if (el.paused) {
      el.play().catch(e => {
        console.error(e)
        setError('Playback failed')
      })
    } else {
      el.pause()
    }
  }

  const handleDelete = () => {
    if (typeof getPos !== 'function') return
    const pos = getPos()
    if (pos == null) return
    editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run()
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <NodeViewWrapper
      as="div"
      data-audio-id={audioId}
      contentEditable={false}
      draggable="true"
      data-drag-handle=""
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 12px',
        margin: '8px 0',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-light)',
        borderRadius: '10px',
        userSelect: 'none',
        maxWidth: '360px',
      }}
    >
      <button
        onClick={togglePlay}
        disabled={status === 'loading'}
        title={playing ? 'Pause' : 'Play'}
        style={{
          width: 34, height: 34, flexShrink: 0,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--accent)',
          color: '#fff',
          cursor: status === 'loading' ? 'wait' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {status === 'loading' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/>
            <path fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
        ) : playing ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1"/>
            <rect x="14" y="5" width="4" height="14" rx="1"/>
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 4l14 8-14 8V4z"/>
          </svg>
        )}
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          height: 4, background: 'var(--border-light)', borderRadius: 2, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: 'var(--accent)', transition: 'width 0.1s linear',
          }} />
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '4px',
          fontFamily: 'var(--font-body)',
        }}>
          <span>{error ? error : formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <button
        onClick={() => setShowTranscript(true)}
        title="Transcript"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)', padding: '4px',
          display: 'flex', alignItems: 'center',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M4 6h16M4 12h16M4 18h10"/>
        </svg>
      </button>

      <button
        onClick={handleDelete}
        title="Remove audio"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)', padding: '4px',
          display: 'flex', alignItems: 'center',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>
        </svg>
      </button>

      {showTranscript && (
        <TranscriptModal audioId={audioId} onClose={() => setShowTranscript(false)} />
      )}

      {objectUrl && (
        <audio
          ref={audioRef}
          src={objectUrl}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCurrentTime(0) }}
          onLoadedMetadata={e => {
            const d = e.currentTarget.duration
            if (isFinite(d) && d > 0) setDuration(d)
          }}
          onCanPlay={tryAutoplay}
          onTimeUpdate={e => setCurrentTime(e.currentTarget.currentTime)}
          style={{ display: 'none' }}
        />
      )}
    </NodeViewWrapper>
  )
}

export const AudioNode = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      audioId: { default: null },
      duration: { default: 0 },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-audio-id]',
        getAttrs: (el) => ({
          audioId: el.getAttribute('data-audio-id'),
          duration: parseFloat(el.getAttribute('data-duration')) || 0,
        }),
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-audio-id': node.attrs.audioId,
      'data-duration': String(node.attrs.duration || 0),
    })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AudioNodeView)
  },

  addCommands() {
    return {
      insertAudio: (attrs) => ({ commands }) => {
        return commands.insertContent({
          type: this.name,
          attrs,
        })
      },
    }
  },
})
