import { useEffect, useState } from 'react'
import useAppStore from '../../store/useAppStore'
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from '../../services/transcribe'

export default function TranscriptModal({ audioId, onClose }) {
  const getAudioRecord = useAppStore(s => s.getAudioRecord)
  const saveAudioTranscript = useAppStore(s => s.saveAudioTranscript)
  const config = useAppStore(s => s.config)

  const [record, setRecord] = useState(null)
  const [loading, setLoading] = useState(true)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const rec = await getAudioRecord(audioId)
        if (!cancelled) setRecord(rec || null)
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load audio')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [audioId, getAudioRecord])

  const handleTranscribe = async () => {
    if (!record?.blob) {
      setError('Audio not available')
      return
    }
    const apiKey = config?.groqApiKey
    if (!apiKey) {
      setError('Add your Groq API key in Settings first')
      return
    }
    const model = config?.groqModel || DEFAULT_GROQ_MODEL
    setTranscribing(true)
    setError(null)
    try {
      const text = await transcribeWithGroq({ blob: record.blob, apiKey, model })
      const updated = await saveAudioTranscript(audioId, text, model)
      setRecord(updated || { ...record, transcript: text, transcriptModel: model })
    } catch (e) {
      setError(e.message || 'Transcription failed')
    } finally {
      setTranscribing(false)
    }
  }

  const transcript = record?.transcript || ''
  const hasTranscript = !!transcript

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '560px', maxHeight: '85vh',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-light)',
          borderRadius: '12px',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
        }}>
          <h2 style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>
            Transcript
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-tertiary)', padding: '4px',
              display: 'flex', alignItems: 'center',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M6 18L18 6"/>
            </svg>
          </button>
        </div>

        <div style={{ padding: '16px', overflowY: 'auto', flex: 1, minHeight: '120px' }}>
          {loading ? (
            <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Loading…</p>
          ) : hasTranscript ? (
            <div>
              <p style={{
                fontSize: '14px', color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap', lineHeight: 1.6,
              }}>{transcript}</p>
              {record?.transcriptModel && (
                <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '12px' }}>
                  {record.transcriptModel}
                  {record.transcribedAt ? ` · ${new Date(record.transcribedAt).toLocaleString()}` : ''}
                </p>
              )}
            </div>
          ) : (
            <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
              No transcript yet. Click Transcribe to generate one with Groq Whisper.
            </p>
          )}

          {error && (
            <p style={{
              fontSize: '12px', color: '#FCA5A5', marginTop: '12px',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: '8px', padding: '8px 12px',
            }}>{error}</p>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '12px 16px', borderTop: '1px solid var(--border-light)',
        }}>
          <button
            onClick={handleTranscribe}
            disabled={transcribing || loading || !record?.blob}
            style={{
              fontSize: '13px', fontWeight: 500,
              color: 'var(--accent)', background: 'var(--accent-light)',
              border: 'none', padding: '8px 18px', borderRadius: '8px',
              cursor: transcribing || loading ? 'wait' : 'pointer',
              fontFamily: 'var(--font-body)',
              opacity: (transcribing || loading || !record?.blob) ? 0.6 : 1,
            }}
          >
            {transcribing ? 'Transcribing…' : hasTranscript ? 'Re-transcribe' : 'Transcribe'}
          </button>
          {hasTranscript && !transcribing && (
            <button
              onClick={() => navigator.clipboard?.writeText(transcript)}
              style={{
                fontSize: '13px',
                color: 'var(--text-secondary)',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-light)',
                padding: '8px 14px', borderRadius: '8px',
                cursor: 'pointer', fontFamily: 'var(--font-body)',
              }}
            >
              Copy
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
