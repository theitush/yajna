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

function AudioNodeView({ node, editor, getPos, extension }) {
  const audioId = node.attrs.audioId
  const getAudioRecord = useAppStore(s => s.getAudioRecord)
  const saveAudioTranscript = useAppStore(s => s.saveAudioTranscript)
  const trashAudio = useAppStore(s => s.trashAudio)
  const readOnly = !!extension?.options?.readOnly
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
  const [segments, setSegments] = useState(null)
  const [transcriptModel, setTranscriptModel] = useState(null)
  const [transcribing, setTranscribing] = useState(false)
  const [transcriptError, setTranscriptError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRetranscribe, setConfirmRetranscribe] = useState(false)
  const [draftTranscript, setDraftTranscript] = useState('')
  const [selected, setSelected] = useState(false)
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
      // Only hydrate transcript state if we don't already have one in memory —
      // loadBlob can be called mid-edit (e.g. clicking another segment seeks,
      // which may lazy-load the blob), and we must not clobber pending edits.
      if (rec.transcript && !transcript) {
        setTranscript(rec.transcript)
        setDraftTranscript(rec.transcript)
        setTranscriptModel(rec.transcriptModel || null)
        setSegments(Array.isArray(rec.transcriptSegments) ? rec.transcriptSegments : null)
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
      const result = await transcribeWithGroq({ blob, apiKey, model })
      const text = typeof result === 'string' ? result : (result?.text || '')
      const segs = typeof result === 'object' && Array.isArray(result?.segments) ? result.segments : null
      await saveAudioTranscript(audioId, text, model, segs)
      setTranscript(text)
      setDraftTranscript(text)
      setTranscriptModel(model)
      setSegments(segs)
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

  useEffect(() => {
    if (!editor) return
    const update = () => {
      if (typeof getPos !== 'function') return
      const pos = getPos()
      if (pos == null) { setSelected(false); return }
      const { from, to } = editor.state.selection
      const nodeFrom = pos
      const nodeTo = pos + node.nodeSize
      setSelected(from < nodeTo && to > nodeFrom && from !== to)
    }
    editor.on('selectionUpdate', update)
    editor.on('transaction', update)
    update()
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('transaction', update)
    }
  }, [editor, getPos, node])

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

  const commitSegmentEdit = (idx, newText) => {
    if (!Array.isArray(segments)) return
    const trimmed = newText.replace(/\s+/g, ' ').trim()
    if (trimmed === segments[idx].text) return
    const updated = segments.map((s, i) => i === idx ? { ...s, text: trimmed } : s)
    const joined = updated.map(s => s.text).join(' ')
    setSegments(updated)
    setDraftTranscript(joined)
    setTranscript(joined)
    saveAudioTranscript(audioId, joined, transcriptModel, updated)
  }

  const handleDelete = async () => {
    if (typeof getPos !== 'function') return
    const pos = getPos()
    if (pos == null) return
    // Soft-delete first (records source for Trash), then remove from the doc.
    const getSource = extension?.options?.getSource
    let source = null
    try { source = typeof getSource === 'function' ? getSource() : null } catch {}
    try { await trashAudio(audioId, source) } catch (e) { console.warn('trashAudio failed', e) }
    editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run()
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  const seekTo = async (time) => {
    const t = Math.max(0, Math.min(duration || 0, time))
    if (!audioRef.current) {
      await loadBlob()
    }
    const el = audioRef.current
    if (el) {
      try { el.currentTime = t } catch { /* ignore */ }
    }
    setCurrentTime(t)
  }

  const seekFromEvent = (e, rect) => {
    const r = rect || e.currentTarget.getBoundingClientRect()
    const x = (e.clientX ?? 0) - r.left
    const ratio = Math.max(0, Math.min(1, x / Math.max(1, r.width)))
    seekTo(ratio * (duration || 0))
  }

  const handleSeekPointerDown = (e) => {
    if (!duration) return
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    seekFromEvent(e, rect)
    const onMove = (ev) => seekFromEvent(ev, rect)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activeSegmentIdx = (() => {
    if (!Array.isArray(segments) || segments.length === 0) return -1
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (currentTime >= s.start && currentTime < s.end) return i
    }
    return -1
  })()

  return (
    <NodeViewWrapper
      as="div"
      data-audio-id={audioId}
      contentEditable={false}
      style={{
        margin: '8px 0',
        background: selected ? 'var(--accent-light)' : 'var(--bg-secondary)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-light)'}`,
        borderRadius: '10px',
        maxWidth: '360px',
        overflow: 'hidden',
        boxShadow: selected ? '0 0 0 2px var(--accent-light)' : 'none',
        transition: 'background 0.12s, border-color 0.12s, box-shadow 0.12s',
      }}
    >
     <div style={{
         display: 'flex',
         alignItems: 'center',
         gap: '10px',
         padding: '8px 12px',
         userSelect: 'none',
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
        <div
          onPointerDown={handleSeekPointerDown}
          style={{
            height: 14, display: 'flex', alignItems: 'center',
            cursor: duration ? 'pointer' : 'default',
            touchAction: 'none',
          }}
        >
          <div style={{
            width: '100%', height: 4,
            background: 'var(--border-light)', borderRadius: 2,
            position: 'relative', overflow: 'visible',
          }}>
            <div style={{
              height: '100%', width: `${progress}%`,
              background: 'var(--accent)', borderRadius: 2,
            }} />
            <div style={{
              position: 'absolute', top: '50%', left: `${progress}%`,
              width: 10, height: 10, borderRadius: '50%',
              background: 'var(--accent)',
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
              display: duration ? 'block' : 'none',
            }} />
          </div>
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

      {!readOnly && (
      <button
        onClick={() => setConfirmDelete(true)}
        title="Move to trash"
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
      )}

     </div>

     {confirmDelete && (
       <div style={{
         padding: '0 12px 10px', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end',
       }}>
         <button
           onClick={handleDelete}
           style={{
             fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
             background: 'rgba(239,68,68,0.15)', color: '#FCA5A5',
             border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
             fontFamily: 'var(--font-body)',
           }}
         >
           Move to trash
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
         userSelect: 'text',
         WebkitUserSelect: 'text',
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
             display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', justifyContent: 'flex-end',
           }}>
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
         {transcript && Array.isArray(segments) && segments.length > 0 && (
           <div
             contentEditable
             suppressContentEditableWarning
             spellCheck={false}
             onKeyDown={e => {
               if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
             }}
             onMouseDown={e => {
               const segEl = e.target?.closest?.('[data-segment-idx]')
               if (!segEl) return
               const idx = Number(segEl.dataset.segmentIdx)
               if (Number.isInteger(idx) && segments[idx]) seekTo(segments[idx].start)
             }}
             onBlur={e => {
               const root = e.currentTarget
               const updated = segments.map((s, idx) => {
                 const node = root.querySelector(`[data-segment-idx="${idx}"]`)
                 const text = (node?.textContent || '').replace(/\s+/g, ' ').trim()
                 return text && text !== s.text ? { ...s, text } : s
               })
               const changed = updated.some((s, idx) => s.text !== segments[idx].text)
               if (!changed) return
               const joined = updated.map(s => s.text).join(' ')
               setSegments(updated)
               setDraftTranscript(joined)
               setTranscript(joined)
               saveAudioTranscript(audioId, joined, transcriptModel, updated)
             }}
             style={{
               userSelect: 'text', WebkitUserSelect: 'text',
               fontSize: '13px', color: 'var(--text-primary)',
               background: 'var(--bg-secondary)',
               border: '1px solid var(--border-light)', borderRadius: '6px',
               padding: '8px 10px', lineHeight: 1.6,
               fontFamily: 'var(--font-body)',
               maxHeight: 260, overflowY: 'auto',
               outline: 'none',
               cursor: 'text',
             }}
           >
             {segments.map((s, i) => (
               <span
                 key={`${i}-${s.text}`}
                 data-segment-idx={i}
                 title={`${formatTime(s.start)} — click to seek`}
                 style={{
                   background: i === activeSegmentIdx ? 'var(--accent-light)' : 'transparent',
                   color: i === activeSegmentIdx ? 'var(--accent)' : 'inherit',
                   borderRadius: 3,
                 }}
               >{s.text}{i < segments.length - 1 ? ' ' : ''}</span>
             ))}
           </div>
         )}
         {transcript && (!Array.isArray(segments) || segments.length === 0) && (
           <div
             contentEditable
             suppressContentEditableWarning
             spellCheck={false}
             dangerouslySetInnerHTML={{ __html: transcript }}
             onBlur={e => {
               const next = e.currentTarget.textContent || ''
               if (next === transcript) return
               setDraftTranscript(next)
               setTranscript(next)
               saveAudioTranscript(audioId, next, transcriptModel, null)
             }}
             style={{
               fontSize: '13px', color: 'var(--text-primary)',
               background: 'var(--bg-secondary)',
               border: '1px solid var(--border-light)', borderRadius: '6px',
               padding: '8px 10px', lineHeight: 1.6,
               fontFamily: 'var(--font-body)',
               maxHeight: 260, overflowY: 'auto',
               whiteSpace: 'pre-wrap',
               outline: 'none',
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
  draggable: false,
  selectable: false,

  addOptions() {
    return {
      // getSource: () => ({ sourceType, sourceId, sourceTitle })
      // Called when the user soft-deletes the audio so Trash can show where it came from.
      getSource: null,
      readOnly: false,
    }
  },

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
