import { useEffect, useRef, useState } from 'react'
import useAppStore from '../../store/useAppStore'

/**
 * Floating mic button. Tap to start recording, tap again to stop.
 * On stop, saves the blob locally, inserts an AudioNode into the editor,
 * and triggers a Drive upload in the background.
 */
export default function RecordFab({ editor }) {
  const saveAudioBlob = useAppStore(s => s.saveAudioBlob)
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const mediaRecorder = useRef(null)
  const chunks = useRef([])
  const streamRef = useRef(null)
  const startTimeRef = useRef(0)
  const tickRef = useRef(null)
  const wakeLockRef = useRef(null)

  // Keep the screen awake while recording. On mobile, when the display sleeps
  // the tab is suspended and MediaRecorder stops capturing — so we hold a
  // Screen Wake Lock for the duration of the recording. The OS auto-releases
  // the lock whenever the page is hidden, so we also re-acquire it when the
  // page becomes visible again (see the visibilitychange listener below).
  const acquireWakeLock = async () => {
    if (!('wakeLock' in navigator)) return
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen')
    } catch (e) {
      // Throws if the page isn't visible or the request is denied — not fatal.
      void e
    }
  }

  const releaseWakeLock = async () => {
    const lock = wakeLockRef.current
    wakeLockRef.current = null
    if (lock) {
      try { await lock.release() } catch (e) { void e }
    }
  }

  useEffect(() => {
    const onVisibility = () => {
      const rec = mediaRecorder.current
      if (document.visibilityState === 'hidden') {
        // A suspended tab stops feeding audio to MediaRecorder anyway, but its
        // clock keeps advancing — on resume the next cluster gets stamped with
        // the wall-clock gap, inflating the file's Duration (Brave Android).
        // Pausing freezes the timeline so the recording stays well-formed.
        if (rec && rec.state === 'recording') {
          try { rec.pause() } catch (e) { void e }
        }
      } else if (document.visibilityState === 'visible' && recording) {
        if (rec && rec.state === 'paused') {
          try { rec.resume() } catch (e) { void e }
        }
        // Re-acquire if we lost the lock while hidden but are still recording.
        if (!wakeLockRef.current) acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [recording])

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (tickRef.current) clearInterval(tickRef.current)
      if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
        try { mediaRecorder.current.stop() } catch (e) { void e }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      releaseWakeLock()
    }
  }, [])

  const starting = useRef(false)

  const start = async () => {
    if (starting.current) return
    starting.current = true
    setError(null)
    try {
      // Defensive: release any stream left behind from a prior session
      // (Firefox Android sometimes keeps tracks live across recordings,
      // which makes the next getUserMedia hang.)
      if (streamRef.current) {
        try { streamRef.current.getTracks().forEach(t => t.stop()) } catch (e) { void e }
        streamRef.current = null
      }

      const gumPromise = navigator.mediaDevices.getUserMedia({ audio: true })
      const stream = await Promise.race([
        gumPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('gum-timeout')), 5000)),
      ])
      streamRef.current = stream
      chunks.current = []
      const rec = new MediaRecorder(stream)
      mediaRecorder.current = rec
      rec.ondataavailable = e => {
        if (e.data.size > 0) chunks.current.push(e.data)
      }
      rec.onstop = handleStop
      rec.start()
      startTimeRef.current = Date.now()
      setElapsed(0)
      setRecording(true)
      acquireWakeLock()
      tickRef.current = setInterval(() => {
        setElapsed((Date.now() - startTimeRef.current) / 1000)
      }, 250)
    } catch (e) {
      console.error(e)
      setError(e?.message === 'gum-timeout' ? 'Mic unavailable — retry' : 'Mic denied')
      setTimeout(() => setError(null), 2500)
    } finally {
      starting.current = false
    }
  }

  const stop = () => {
    if (mediaRecorder.current && mediaRecorder.current.state !== 'inactive') {
      mediaRecorder.current.stop()
    }
    setRecording(false)
    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
    releaseWakeLock()
  }

  const handleStop = async () => {
    const stream = streamRef.current
    if (stream) stream.getTracks().forEach(t => t.stop())
    streamRef.current = null

    const duration = (Date.now() - startTimeRef.current) / 1000
    if (chunks.current.length === 0) return
    const blob = new Blob(chunks.current, { type: mediaRecorder.current?.mimeType || 'audio/webm' })
    chunks.current = []

    setSaving(true)
    try {
      // Stamp the driveFileId onto the node once the upload resolves so the
      // doc reference is self-sufficient (no separate metadata file). Until
      // then the node still works locally via the IDB blob.
      const stampDriveFileId = (audioId, driveFileId) => {
        if (!editor || !driveFileId) return
        let pos = null
        editor.state.doc.descendants((n, p) => {
          if (n.type.name === 'audio' && n.attrs.audioId === audioId) { pos = p; return false }
        })
        if (pos == null) return
        editor.chain().command(({ tr }) => {
          const cur = tr.doc.nodeAt(pos)
          if (!cur || cur.type.name !== 'audio') return false
          tr.setNodeMarkup(pos, undefined, { ...cur.attrs, driveFileId })
          return true
        }).run()
      }
      const { id, mimeType, createdAt } = await saveAudioBlob(
        blob, duration, (driveFileId) => stampDriveFileId(id, driveFileId)
      )
      if (editor) {
        // Recordings always append to the END of the document — never at the
        // caret. focus('end') puts the cursor past all existing content
        // (including any prior recording), so the clip lands after it.
        editor.chain().focus('end').insertAudio({ audioId: id, duration, mimeType, createdAt, autoTranscribe: true }).run()
      }
    } catch (e) {
      console.error(e)
      setError('Save failed')
      setTimeout(() => setError(null), 2500)
    } finally {
      setSaving(false)
    }
  }

  const handleActivate = (e) => {
    // Prevent the tap from being consumed by keyboard-dismiss on mobile Firefox
    e.preventDefault()
    if (saving) return
    // If a soft keyboard is open, blur the active editor so the viewport
    // settles before getUserMedia runs.
    const active = document.activeElement
    if (active && typeof active.blur === 'function' && active !== document.body) {
      active.blur()
    }
    if (recording) stop()
    else start()
  }

  const mm = Math.floor(elapsed / 60)
  const ss = Math.floor(elapsed % 60).toString().padStart(2, '0')

  return (
    <div
      style={{
        position: 'fixed',
        right: '20px',
        bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}
    >
      {error && (
        <span style={{
          fontSize: '11px', color: '#FCA5A5',
          background: 'var(--bg-elevated)', padding: '6px 10px',
          borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)',
          fontFamily: 'var(--font-body)',
        }}>{error}</span>
      )}
      {recording && (
        <span style={{
          fontSize: '12px', color: '#FCA5A5',
          background: 'var(--bg-elevated)', padding: '6px 10px',
          borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)',
          fontFamily: 'var(--font-body)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          ● {mm}:{ss}
        </span>
      )}
      <button
        onPointerDown={handleActivate}
        onClick={(e) => e.preventDefault()}
        disabled={saving}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
        title={recording ? 'Stop recording' : 'Record audio'}
        style={{
          width: 52, height: 52,
          borderRadius: '50%',
          border: 'none',
          cursor: saving ? 'wait' : 'pointer',
          background: recording ? '#ef4444' : 'var(--accent)',
          color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
          transition: 'transform 0.12s, background 0.15s',
          transform: recording ? 'scale(1.05)' : 'scale(1)',
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {saving ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/>
            <path fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
        ) : recording ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        )}
      </button>
    </div>
  )
}
