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
    }
  }, [])

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      tickRef.current = setInterval(() => {
        setElapsed((Date.now() - startTimeRef.current) / 1000)
      }, 250)
    } catch (e) {
      console.error(e)
      setError('Mic denied')
      setTimeout(() => setError(null), 2500)
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
      const id = await saveAudioBlob(blob, duration)
      if (editor) {
        editor.chain().focus().insertAudio({ audioId: id, duration }).run()
      }
    } catch (e) {
      console.error(e)
      setError('Save failed')
      setTimeout(() => setError(null), 2500)
    } finally {
      setSaving(false)
    }
  }

  const onClick = () => {
    if (saving) return
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
        onClick={onClick}
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
