import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import useAppStore from '../../store/useAppStore'
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from '../../services/transcribe'

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function AudioNodeView({ node, editor, getPos }) {
  const audioId = node.attrs.audioId
  const getAudioRecord = useAppStore(s => s.getAudioRecord)
  const saveAudioTranscript = useAppStore(s => s.saveAudioTranscript)
  const config = useAppStore(s => s.config)
  const audioRef = useRef(null)
  const [objectUrl, setObjectUrl] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(node.attrs.duration || 0)
  const [currentTime, setCurrentTime] = useState(0)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [transcriptModel, setTranscriptModel] = useState(null)
  const [transcribing, setTranscribing] = useState(false)
  const [transcriptError, setTranscriptError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRetranscribe, setConfirmRetranscribe] = useState(false)
  const [draftTranscript, setDraftTranscript] = useState('')
  const [savingTranscript, setSavingTranscript] = useState(false)
  const blobRef = useRef(null)
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
      blobRef.current = rec.blob
      const url = URL.createObjectURL(rec.blob)
      setObjectUrl(url)
      setStatus('ready')
      if (rec.duration) setDuration(rec.duration)
      if (rec.transcript) {
        setTranscript(rec.transcript)
        setDraftTranscript(rec.transcript)
        setTranscriptModel(rec.transcriptModel || null)
      }
      return url
    } catch (e) {
      console.error('Audio load failed', e)
      setStatus('error')
      setError('Could not load audio')
      return null
    }
  }

  const handleToggleExpand = async () => {
    const next = !expanded
    setExpanded(next)
    if (next && !transcript && !blobRef.current) {
      // Pre-load so we can show any saved transcript and have the blob ready
      await loadBlob()
    }
  }

  const handleTranscribe = async () => {
    setConfirmRetranscribe(false)
    setTranscriptError(null)
    const apiKey = config?.groqApiKey
    if (!apiKey) {
      setTranscriptError('Add your Groq API key in Settings first')
      return
    }
    let blob = blobRef.current
    if (!blob) {
      const rec = await getAudioRecord(audioId)
      blob = rec?.blob || null
      if (blob) blobRef.current = blob
    }
    if (!blob) {
      setTranscriptError('Audio not available')
      return
    }
    const model = config?.groqModel || DEFAULT_GROQ_MODEL
    setTranscribing(true)
    try {
      const text = await transcribeWithGroq({ blob, apiKey, model })
      await saveAudioTranscript(audioId, text, model)
      setTranscript(text)
      setDraftTranscript(text)
      setTranscriptModel(model)
    } catch (e) {
      setTranscriptError(e.message || 'Transcription failed')
    } finally {
      setTranscribing(false)
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

  const handleSaveTranscript = async () => {
    if (draftTranscript === transcript) return
    setSavingTranscript(true)
    try {
      await saveAudioTranscript(audioId, draftTranscript, transcriptModel)
      setTranscript(draftTranscript)
    } catch (e) {
      setTranscriptError(e.message || 'Could not save transcript')
    } finally {
      setSavingTranscript(false)
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
        margin: '8px 0',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-light)',
        borderRadius: '10px',
        userSelect: 'none',
        maxWidth: '360px',
        overflow: 'hidden',
      }}
    >
     <div style={{
       display: 'flex',
       alignItems: 'center',
       gap: '10px',
       padding: '8px 12px',
     }}>
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

      <button
        onClick={handleToggleExpand}
        title={expanded ? 'Hide transcript' : 'Show transcript'}
        aria-expanded={expanded}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)', padding: '4px', marginLeft: '-4px',
          display: 'flex', alignItems: 'center',
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6"/>
        </svg>
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
        onClick={() => setConfirmDelete(true)}
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

     </div>

     {confirmDelete && (
       <div style={{
         padding: '0 12px 10px', display: 'flex', alignItems: 'center', gap: '8px',
       }}>
         <p style={{ fontSize: '12px', color: '#FCA5A5', flex: 1 }}>Delete this recording?</p>
         <button
           onClick={handleDelete}
           style={{
             fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
             background: 'rgba(239,68,68,0.15)', color: '#FCA5A5',
             border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
             fontFamily: 'var(--font-body)',
           }}
         >
           Delete
         </button>
         <button
           onClick={() => setConfirmDelete(false)}
           style={{
             fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
             background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
             border: '1px solid var(--border-light)', cursor: 'pointer',
             fontFamily: 'var(--font-body)',
           }}
         >
           Cancel
         </button>
       </div>
     )}

     {expanded && (
       <div style={{
         padding: '10px 12px 12px',
         borderTop: '1px solid var(--border-light)',
         background: 'var(--bg-primary)',
       }}>
         <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: transcript || transcriptError || confirmRetranscribe ? '10px' : 0 }}>
           <button
             onClick={() => {
               if (transcribing) return
               if (transcript) setConfirmRetranscribe(true)
               else handleTranscribe()
             }}
             disabled={transcribing}
             style={{
               fontSize: '12px', fontWeight: 500,
               color: 'var(--accent)', background: 'var(--accent-light)',
               border: 'none', padding: '6px 12px', borderRadius: '6px',
               cursor: transcribing ? 'wait' : 'pointer',
               fontFamily: 'var(--font-body)',
               opacity: transcribing ? 0.6 : 1,
             }}
           >
             {transcribing ? 'Transcribing…' : transcript ? 'Re-transcribe' : 'Transcribe'}
           </button>
           {transcriptModel && (
             <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
               {transcriptModel}
             </span>
           )}
         </div>
         {confirmRetranscribe && (
           <div style={{
             display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px',
           }}>
             <p style={{ fontSize: '12px', color: '#FCA5A5', flex: 1, margin: 0 }}>
               Overwrite current transcript?
             </p>
             <button
               onClick={handleTranscribe}
               style={{
                 fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                 background: 'rgba(239,68,68,0.15)', color: '#FCA5A5',
                 border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
                 fontFamily: 'var(--font-body)',
               }}
             >
               Overwrite
             </button>
             <button
               onClick={() => setConfirmRetranscribe(false)}
               style={{
                 fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                 background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
                 border: '1px solid var(--border-light)', cursor: 'pointer',
                 fontFamily: 'var(--font-body)',
               }}
             >
               Cancel
             </button>
           </div>
         )}
         {transcriptError && (
           <p style={{
             fontSize: '11px', color: '#FCA5A5',
             background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
             borderRadius: '6px', padding: '6px 10px', marginBottom: transcript ? '10px' : 0,
           }}>{transcriptError}</p>
         )}
         {transcript && (
           <textarea
             value={draftTranscript}
             onChange={e => setDraftTranscript(e.target.value)}
             onBlur={handleSaveTranscript}
             disabled={savingTranscript}
             rows={Math.min(12, Math.max(2, draftTranscript.split('\n').length))}
             style={{
               width: '100%', boxSizing: 'border-box',
               fontSize: '13px', color: 'var(--text-primary)',
               background: 'var(--bg-secondary)',
               border: '1px solid var(--border-light)', borderRadius: '6px',
               padding: '8px 10px', lineHeight: 1.5,
               fontFamily: 'var(--font-body)',
               resize: 'vertical',
               margin: 0,
             }}
           />
         )}
         {!transcript && !transcribing && !transcriptError && (
           <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', margin: 0 }}>
             No transcript yet.
           </p>
         )}
       </div>
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
  selectable: false,

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

  addKeyboardShortcuts() {
    const name = this.name
    const blockIfAdjacent = (direction) => ({ editor }) => {
      const { state } = editor
      const { selection } = state
      if (!selection.empty) {
        let hasAudio = false
        state.doc.nodesBetween(selection.from, selection.to, (n) => {
          if (n.type.name === name) hasAudio = true
        })
        if (hasAudio) return true
        return false
      }
      const $pos = selection.$from
      if (direction === 'before') {
        if ($pos.parentOffset !== 0) return false
        const posBefore = $pos.before()
        if (posBefore <= 0) return false
        const nodeBefore = state.doc.resolve(posBefore).nodeBefore
        if (nodeBefore && nodeBefore.type.name === name) return true
      } else {
        if ($pos.parentOffset !== $pos.parent.content.size) return false
        const posAfter = $pos.after()
        if (posAfter >= state.doc.content.size) return false
        const nodeAfter = state.doc.resolve(posAfter).nodeAfter
        if (nodeAfter && nodeAfter.type.name === name) return true
      }
      return false
    }
    return {
      Backspace: blockIfAdjacent('before'),
      Delete: blockIfAdjacent('after'),
    }
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
