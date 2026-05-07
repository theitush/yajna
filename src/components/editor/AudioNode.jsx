import { Node, mergeAttributes } from '@tiptap/core'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import useAppStore from '../../store/useAppStore'
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from '../../services/transcribe'

// Manually place the caret at the mousedown point. Needed because the
// surrounding PM atom node-view has contentEditable=false on its wrapper,
// and PM's selection sync would otherwise overwrite the browser's natural
// caret placement with a NodeSelection on the audio atom (caret snaps to
// the start of the editor, or refuses to move).
function placeCaretFromPoint(e) {
  const sel = window.getSelection?.()
  if (!sel) return
  const x = e.clientX
  const y = e.clientY
  let range = null
  if (typeof document.caretPositionFromPoint === 'function') {
    const pos = document.caretPositionFromPoint(x, y)
    if (pos?.offsetNode) {
      range = document.createRange()
      range.setStart(pos.offsetNode, pos.offset)
      range.collapse(true)
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    range = document.caretRangeFromPoint(x, y)
  }
  if (!range) return
  sel.removeAllRanges()
  sel.addRange(range)
}

// Uncontrolled contentEditable for the segmented transcript. We render the
// segments to DOM exactly once per `signature` (the joined segment timings) —
// after that, user keystrokes mutate the DOM directly and React does not
// reconcile this subtree. The active-segment highlight is applied via a
// direct-DOM effect so playback updates don't churn the editor (which used
// to cause backspace/delete to "duplicate" the very char being deleted).
function SegmentedTranscriptEditor({
  segments,
  signature,
  activeSegmentIdx,
  onSeek,
  onCommit,
}) {
  const rootRef = useRef(null)
  const saveTimer = useRef(null)
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments

  // Mount: render initial segments into the DOM once. Re-runs only when the
  // external segment shape changes (re-transcribe, swap clip, etc).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.replaceChildren()
    segments.forEach((s, i) => {
      const span = document.createElement('span')
      span.dataset.segmentIdx = String(i)
      span.title = `${formatTime(s.start)} — click to seek`
      span.style.borderRadius = '3px'
      const trailing = i < segments.length - 1 ? ' ' : ''
      span.textContent = `${s.text}${trailing}`
      root.appendChild(span)
    })
    // No deps on `segments` content — only `signature` — so user edits don't
    // remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Highlight active segment via direct DOM. Avoids React re-renders during
  // playback that would otherwise reconcile the contentEditable subtree.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const spans = root.querySelectorAll('[data-segment-idx]')
    spans.forEach((el, i) => {
      const active = i === activeSegmentIdx
      el.style.background = active ? 'var(--accent-light)' : 'transparent'
      el.style.color = active ? 'var(--accent)' : 'inherit'
    })
  }, [activeSegmentIdx, signature])

  const readSegments = () => {
    const root = rootRef.current
    if (!root) return null
    const base = segmentsRef.current
    const next = base.map((s, idx) => {
      const el = root.querySelector(`[data-segment-idx="${idx}"]`)
      // Strip the trailing separator space we inserted at render time.
      let text = el?.textContent ?? ''
      if (idx < base.length - 1 && text.endsWith(' ')) text = text.slice(0, -1)
      return text === s.text ? s : { ...s, text }
    })
    const changed = next.some((s, i) => s !== base[i])
    return { next, changed }
  }

  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const result = readSegments()
    if (!result || !result.changed) return
    onCommit(result.next, { immediate: true })
  }

  return (
    <div
      ref={rootRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      dir="auto"
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
      }}
      onMouseDown={e => {
        // The audio node is a PM atom with contentEditable=false on its
        // wrapper; PM's selection sync would otherwise force a NodeSelection
        // on the audio and snap the DOM caret away from where the user
        // clicked. Stop both React + native propagation so PM's view-level
        // listeners don't fire, and place the caret ourselves from the
        // click point — preventDefault keeps the browser from doing its
        // own (now-conflicting) caret placement.
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation?.()
        e.preventDefault()
        placeCaretFromPoint(e)
        const segEl = e.target?.closest?.('[data-segment-idx]')
        if (!segEl) return
        const idx = Number(segEl.dataset.segmentIdx)
        const segs = segmentsRef.current
        if (Number.isInteger(idx) && segs[idx]) onSeek(segs[idx].start)
      }}
      onInput={() => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          const result = readSegments()
          if (!result || !result.changed) return
          onCommit(result.next, { immediate: false })
        }, 600)
      }}
      onBlur={flush}
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
        textAlign: 'start',
      }}
    />
  )
}

// Uncontrolled contentEditable for plain (segment-less) transcripts.
function PlainTranscriptEditor({ initialHtml, onCommit }) {
  const rootRef = useRef(null)
  const saveTimer = useRef(null)
  // Track the last text we committed to the parent so we can ignore the
  // resulting prop echo (parent sets transcript=text → initialHtml updates →
  // would otherwise wipe the DOM and the user's caret).
  const lastCommittedRef = useRef(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (initialHtml === lastCommittedRef.current) return
    if ((root.textContent || '') === (initialHtml || '')) return
    root.innerHTML = initialHtml || ''
  }, [initialHtml])

  const commit = (text, opts) => {
    lastCommittedRef.current = text
    onCommit(text, opts)
  }

  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const text = rootRef.current?.textContent || ''
    commit(text, { immediate: true })
  }

  return (
    <div
      ref={rootRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      dir="auto"
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
      }}
      onMouseDown={e => {
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation?.()
        e.preventDefault()
        placeCaretFromPoint(e)
      }}
      onInput={() => {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          const text = rootRef.current?.textContent || ''
          commit(text, { immediate: false })
        }, 600)
      }}
      onBlur={flush}
      style={{
        fontSize: '13px', color: 'var(--text-primary)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-light)', borderRadius: '6px',
        padding: '8px 10px', lineHeight: 1.6,
        fontFamily: 'var(--font-body)',
        maxHeight: 260, overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        outline: 'none',
        textAlign: 'start',
      }}
    />
  )
}

const isTouchDevice = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: none) and (pointer: coarse)').matches

// Shared palette: raw RGB triplets reused across audio tints + UI accents
// (mode toggle, status pills, etc). Add new colors here so callers can
// compose them at any alpha.
export const PALETTE = {
  indigo:  '99,102,241',
  emerald: '16,185,129',
  pink:    '236,72,153',
  amber:   '245,158,11',
  sky:     '14,165,233',
}

// 5 subtle tints so adjacent audio cards are visually distinguishable
// even when collapsed. Stable per audioId so the color doesn't change.
const AUDIO_TINTS = [
  { bg: `rgba(${PALETTE.indigo},0.10)`,  border: `rgba(${PALETTE.indigo},0.30)`  },
  { bg: `rgba(${PALETTE.emerald},0.10)`, border: `rgba(${PALETTE.emerald},0.30)` },
  { bg: `rgba(${PALETTE.pink},0.10)`,    border: `rgba(${PALETTE.pink},0.30)`    },
  { bg: `rgba(${PALETTE.amber},0.10)`,   border: `rgba(${PALETTE.amber},0.30)`   },
  { bg: `rgba(${PALETTE.sky},0.10)`,     border: `rgba(${PALETTE.sky},0.30)`     },
]
// Build a Map<audioId, rank> from a list of { id, createdAt, docIdx } items,
// sorted chronologically (legacy clips without createdAt fall back to doc order).
export function rankAudioItems(items) {
  const sorted = [...items].sort((a, b) => {
    const aT = a.createdAt ? Date.parse(a.createdAt) : NaN
    const bT = b.createdAt ? Date.parse(b.createdAt) : NaN
    const aValid = !Number.isNaN(aT)
    const bValid = !Number.isNaN(bT)
    if (aValid && bValid) return aT - bT
    if (aValid) return -1
    if (bValid) return 1
    return a.docIdx - b.docIdx
  })
  const map = new Map()
  sorted.forEach((it, i) => { if (it.id) map.set(it.id, i) })
  return map
}

function rankInDoc(doc, targetId) {
  const items = []
  let docIdx = 0
  doc.descendants((n) => {
    if (n.type.name === 'audio' && n.attrs.audioId) {
      items.push({ id: n.attrs.audioId, createdAt: n.attrs.createdAt, docIdx: docIdx++ })
    }
  })
  return rankAudioItems(items).get(targetId) ?? -1
}

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
  const [expanded, setExpanded] = useState(true)
  const [transcript, setTranscript] = useState('')
  const [segments, setSegments] = useState(null)
  const [transcriptModel, setTranscriptModel] = useState(null)
  const [transcribing, setTranscribing] = useState(false)
  const [transcriptError, setTranscriptError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRetranscribe, setConfirmRetranscribe] = useState(false)
  const [draftTranscript, setDraftTranscript] = useState('')
  // Bumped whenever transcript state is replaced from outside the editor
  // (re-transcribe, hydrate from DB). Used as a `key` on the inner editor so
  // it remounts and rebuilds its DOM — without this, re-transcribing the same
  // clip yields identical segment timings, the signature memo stays equal,
  // and the editor keeps showing the previously-edited text until refresh.
  const [transcriptVersion, setTranscriptVersion] = useState(0)
  const [selected, setSelected] = useState(false)
  const blobRef = useRef(null)
  const pendingPlayRef = useRef(false)
  // Debounced transcript save. We save on input (not just blur) because users
  // sometimes navigate away without firing blur on a contenteditable, which
  // previously dropped edits silently.
  const transcriptSaveTimer = useRef(null)

  const scheduleTranscriptSave = (text, segs) => {
    if (transcriptSaveTimer.current) clearTimeout(transcriptSaveTimer.current)
    transcriptSaveTimer.current = setTimeout(() => {
      transcriptSaveTimer.current = null
      saveAudioTranscript(audioId, text, transcriptModel, segs ?? null)
    }, 600)
  }
  useEffect(() => () => {
    if (transcriptSaveTimer.current) {
      clearTimeout(transcriptSaveTimer.current)
      // Flush on unmount so unmounting the node-view (route change, etc)
      // doesn't lose pending edits.
      saveAudioTranscript(audioId, transcript, transcriptModel, Array.isArray(segments) ? segments : null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        setTranscriptVersion(v => v + 1)
      }
      return url
    } catch (e) {
      console.error('Audio load failed', e)
      setStatus('error')
      setError(e.message || 'Could not load audio')
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
      setTranscriptVersion(v => v + 1)
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

  // Auto-transcribe freshly recorded clips. The flag is set by RecordFab on
  // insert; clear it on first attempt so re-renders don't retry. Errors
  // (no API key, offline, server) surface inline via transcriptError —
  // never a popup.
  useEffect(() => {
    if (!node.attrs.autoTranscribe) return
    if (transcript || transcribing) return
    // Clear the flag eagerly so we don't retry on every render.
    if (editor && typeof getPos === 'function' && !readOnly) {
      const pos = getPos()
      if (pos != null) {
        try {
          editor.chain().command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, autoTranscribe: false })
            return true
          }).run()
        } catch { /* ignore */ }
      }
    }
    if (!config?.groqApiKey) {
      setTranscriptError('Add your Groq API key in Settings to auto-transcribe')
      return
    }
    handleTranscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.attrs.autoTranscribe])

  // Hydrate transcript on mount so the (default-expanded) panel shows it
  // immediately, without forcing the audio blob to be decoded.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!audioId) return
      try {
        const rec = await getAudioRecord(audioId)
        if (cancelled || !rec) return
        // Backfill createdAt onto the node attr for legacy clips so chronological
        // tinting works without re-reading IDB on every render.
        if (rec.createdAt && !node.attrs.createdAt && editor && typeof getPos === 'function') {
          const pos = getPos()
          if (pos != null && !readOnly) {
            try {
              editor.chain().command(({ tr }) => {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, createdAt: rec.createdAt })
                return true
              }).run()
            } catch { /* ignore */ }
          }
        }
        if (transcript) return
        if (rec.duration && !duration) setDuration(rec.duration)
        if (rec.transcript) {
          setTranscript(rec.transcript)
          setDraftTranscript(rec.transcript)
          setTranscriptModel(rec.transcriptModel || null)
          setSegments(Array.isArray(rec.transcriptSegments) ? rec.transcriptSegments : null)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [audioId])

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

  const moveBy = (direction) => {
    if (typeof getPos !== 'function' || !editor) return
    const pos = getPos()
    if (pos == null) return
    const { state } = editor
    const { doc, tr } = state
    const $pos = doc.resolve(pos)
    const parent = $pos.parent
    const indexInParent = $pos.index()
    const targetIndex = direction === 'up' ? indexInParent - 1 : indexInParent + 1
    if (targetIndex < 0 || targetIndex >= parent.childCount) return
    const nodeSize = node.nodeSize
    const parentStart = $pos.start()
    let siblingPos = parentStart
    for (let i = 0; i < targetIndex; i++) siblingPos += parent.child(i).nodeSize
    const siblingNode = parent.child(targetIndex)
    const siblingSize = siblingNode.nodeSize
    const audioSlice = doc.slice(pos, pos + nodeSize)
    let newAudioPos
    if (direction === 'up') {
      // Delete audio first (it's after sibling), then insert before sibling.
      tr.delete(pos, pos + nodeSize)
      tr.insert(siblingPos, audioSlice.content)
      newAudioPos = siblingPos
    } else {
      // Sibling is after audio. Insert copy after sibling, then delete original.
      const insertAt = siblingPos + siblingSize
      tr.insert(insertAt, audioSlice.content)
      tr.delete(pos, pos + nodeSize)
      // Original audio (size nodeSize) was deleted from before insertAt,
      // so the new audio sits at insertAt - nodeSize == siblingPos.
      newAudioPos = siblingPos
    }
    try {
      tr.setSelection(NodeSelection.create(tr.doc, newAudioPos))
    } catch { /* ignore — fall back to whatever selection PM picks */ }
    editor.view.dispatch(tr)
  }

  const canMoveUp = (() => {
    if (typeof getPos !== 'function' || !editor) return false
    const pos = getPos()
    if (pos == null) return false
    return editor.state.doc.resolve(pos).index() > 0
  })()
  const canMoveDown = (() => {
    if (typeof getPos !== 'function' || !editor) return false
    const pos = getPos()
    if (pos == null) return false
    const $pos = editor.state.doc.resolve(pos)
    return $pos.index() < $pos.parent.childCount - 1
  })()

  const handleDelete = () => {
    if (typeof getPos !== 'function') return
    const pos = getPos()
    if (pos == null) return
    // Remove from the doc first so the UI reacts instantly. Soft-delete
    // (which scans IDB for the trash list) runs in the background — failures
    // log but don't block the user.
    const getSource = extension?.options?.getSource
    let source = null
    try { source = typeof getSource === 'function' ? getSource() : null } catch {}
    editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run()
    Promise.resolve()
      .then(() => trashAudio(audioId, source))
      .catch(e => console.warn('trashAudio failed', e))
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const getRank = extension?.options?.getRank
  let rank = -1
  if (typeof getRank === 'function') {
    try {
      const r = getRank(audioId, node.attrs.createdAt)
      if (typeof r === 'number') rank = r
    } catch { /* ignore */ }
  }
  if (rank < 0 && editor) rank = rankInDoc(editor.state.doc, audioId)
  const tint = AUDIO_TINTS[((rank >= 0 ? rank : 0) % AUDIO_TINTS.length + AUDIO_TINTS.length) % AUDIO_TINTS.length]

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
        background: tint.bg,
        border: `1px solid ${selected ? 'var(--accent)' : tint.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
        boxShadow: selected ? '0 0 0 2px var(--accent-light)' : 'none',
        transition: 'border-color 0.12s, box-shadow 0.12s',
      }}
    >
     <div style={{
         display: 'flex',
         alignItems: 'center',
         gap: '10px',
         padding: '8px 12px',
         userSelect: 'none',
       }}>
      {!readOnly && !isTouchDevice && (
      <span
        data-drag-handle
        draggable="true"
        contentEditable={false}
        title="Drag to move"
        style={{
          flexShrink: 0,
          cursor: 'grab',
          color: 'var(--text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          padding: '2px',
          marginLeft: '-4px',
          touchAction: 'none',
        }}
      >
        <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/>
          <circle cx="3" cy="7" r="1.2"/><circle cx="9" cy="7" r="1.2"/>
          <circle cx="3" cy="11" r="1.2"/><circle cx="9" cy="11" r="1.2"/>
        </svg>
      </span>
      )}
      {!readOnly && isTouchDevice && (
      <span
        contentEditable={false}
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          marginLeft: '-4px',
          gap: '2px',
        }}
      >
        <button
          onClick={() => moveBy('up')}
          disabled={!canMoveUp}
          title="Move up"
          style={{
            background: 'none', border: 'none', padding: '2px',
            color: canMoveUp ? 'var(--text-tertiary)' : 'var(--border-light)',
            cursor: canMoveUp ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center',
          }}
        >
          <svg width="12" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <path d="M6 15l6-6 6 6"/>
          </svg>
        </button>
        <button
          onClick={() => moveBy('down')}
          disabled={!canMoveDown}
          title="Move down"
          style={{
            background: 'none', border: 'none', padding: '2px',
            color: canMoveDown ? 'var(--text-tertiary)' : 'var(--border-light)',
            cursor: canMoveDown ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center',
          }}
        >
          <svg width="12" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
      </span>
      )}
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

      {!readOnly && (
      <button
        onClick={() => {
          if (transcribing) return
          if (transcript) setConfirmRetranscribe(true)
          else handleTranscribe()
        }}
        disabled={transcribing}
        title={transcript ? 'Re-transcribe' : 'Transcribe'}
        style={{
          fontSize: '12px', fontWeight: 500,
          color: 'var(--accent)', background: 'var(--accent-light)',
          border: 'none', padding: '6px 12px', borderRadius: '6px',
          cursor: transcribing ? 'wait' : 'pointer',
          fontFamily: 'var(--font-body)',
          opacity: transcribing ? 0.6 : 1,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {transcribing ? 'Transcribing…' : transcript ? 'Re-transcribe' : 'Transcribe'}
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
           <SegmentedTranscriptEditor
             key={`seg-${transcriptVersion}`}
             segments={segments}
             signature={segments.map(s => `${s.start ?? 0}-${s.end ?? 0}`).join('|')}
             activeSegmentIdx={activeSegmentIdx}
             onSeek={seekTo}
             onCommit={(updated, { immediate }) => {
               const joined = updated.map(s => s.text).join(' ')
               setSegments(updated)
               setDraftTranscript(joined)
               setTranscript(joined)
               if (immediate) {
                 if (transcriptSaveTimer.current) {
                   clearTimeout(transcriptSaveTimer.current)
                   transcriptSaveTimer.current = null
                 }
                 saveAudioTranscript(audioId, joined, transcriptModel, updated)
               } else {
                 scheduleTranscriptSave(joined, updated)
               }
             }}
           />
         )}
         {transcript && (!Array.isArray(segments) || segments.length === 0) && (
           <PlainTranscriptEditor
             key={`plain-${transcriptVersion}`}
             initialHtml={transcript}
             onCommit={(text, { immediate }) => {
               if (text === transcript) return
               setDraftTranscript(text)
               setTranscript(text)
               if (immediate) {
                 if (transcriptSaveTimer.current) {
                   clearTimeout(transcriptSaveTimer.current)
                   transcriptSaveTimer.current = null
                 }
                 saveAudioTranscript(audioId, text, transcriptModel, null)
               } else {
                 scheduleTranscriptSave(text, null)
               }
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
  selectable: true,

  addOptions() {
    return {
      // getSource: () => ({ sourceType, sourceId, sourceTitle })
      // Called when the user soft-deletes the audio so Trash can show where it came from.
      getSource: null,
      // getRank: (audioId, createdAt) => number | null
      // Optional override that takes precedence over in-doc ranking. Useful when
      // rendering one block per editor (e.g. ReviewPage) and you want chronological
      // tints to be consistent across the whole day's journal.
      getRank: null,
      readOnly: false,
    }
  },

  addAttributes() {
    return {
      audioId: { default: null },
      duration: { default: 0 },
      createdAt: { default: null },
      // Set to true on freshly recorded clips so the node-view kicks off
      // transcription automatically. Cleared on first attempt so re-renders
      // don't retry forever (errors surface inline in the panel).
      autoTranscribe: { default: false, rendered: false },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-audio-id]',
        getAttrs: (el) => ({
          audioId: el.getAttribute('data-audio-id'),
          duration: parseFloat(el.getAttribute('data-duration')) || 0,
          createdAt: el.getAttribute('data-created-at') || null,
        }),
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = {
      'data-audio-id': node.attrs.audioId,
      'data-duration': String(node.attrs.duration || 0),
    }
    if (node.attrs.createdAt) attrs['data-created-at'] = node.attrs.createdAt
    return ['div', mergeAttributes(HTMLAttributes, attrs)]
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

  addProseMirrorPlugins() {
    const name = this.name
    // When an audio node is the active NodeSelection, typing a character
    // would replace the node (PM default). Instead, drop the selection
    // *after* the node so the typed text appears as a sibling.
    const moveCursorAfterAudio = (view) => {
      const { state, dispatch } = view
      const sel = state.selection
      if (!(sel instanceof NodeSelection)) return false
      if (sel.node?.type?.name !== name) return false
      const after = sel.to
      const $after = state.doc.resolve(after)
      let tr = state.tr
      // If there's no text-selectable position right after the audio (e.g.
      // it's the last block), append a paragraph so the user has somewhere
      // to type.
      if ($after.parent.type.name === 'doc' && !$after.nodeAfter) {
        const para = state.schema.nodes.paragraph?.create()
        if (para) {
          tr = tr.insert(after, para)
          tr = tr.setSelection(TextSelection.create(tr.doc, after + 1))
        } else {
          tr = tr.setSelection(TextSelection.create(tr.doc, after))
        }
      } else {
        // Find nearest text position at/after the node end.
        let pos = after
        try {
          const next = TextSelection.near(tr.doc.resolve(pos), 1)
          tr = tr.setSelection(next)
        } catch {
          tr = tr.setSelection(TextSelection.create(tr.doc, pos))
        }
      }
      dispatch(tr)
      return true
    }
    return [
      new Plugin({
        props: {
          handleTextInput(view) {
            // Returning false lets PM handle insertion *after* we relocate
            // the selection, so the typed character lands after the audio.
            return moveCursorAfterAudio(view) ? false : false
          },
          handleKeyDown(view, event) {
            const sel = view.state.selection
            if (!(sel instanceof NodeSelection)) return false
            if (sel.node?.type?.name !== name) return false
            // Printable single-char keys (letters, digits, symbols, space)
            // should move the cursor past the audio first; PM will then
            // insert the character normally.
            const isPrintable = event.key.length === 1
              && !event.ctrlKey && !event.metaKey && !event.altKey
            if (isPrintable || event.key === 'Enter') {
              moveCursorAfterAudio(view)
              return false
            }
            return false
          },
        },
      }),
    ]
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
