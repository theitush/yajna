import { useState, useRef } from 'react'
import useAppStore from '../../store/useAppStore'

export default function VoiceButton({ onTranscription }) {
  const config = useAppStore(s => s.config)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState(null)
  const mediaRecorder = useRef(null)
  const chunks = useRef([])

  const startRecording = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks.current = []
      mediaRecorder.current = new MediaRecorder(stream)
      mediaRecorder.current.ondataavailable = e => {
        if (e.data.size > 0) chunks.current.push(e.data)
      }
      mediaRecorder.current.onstop = () => handleStop(stream)
      mediaRecorder.current.start()
      setRecording(true)
    } catch (e) {
      setError('Microphone access denied')
    }
  }

  const stopRecording = () => {
    if (mediaRecorder.current?.state !== 'inactive') {
      mediaRecorder.current.stop()
      setRecording(false)
    }
  }

  const handleStop = async (stream) => {
    stream.getTracks().forEach(t => t.stop())
    const blob = new Blob(chunks.current, { type: 'audio/webm' })
    const groqKey = config?.groqApiKey
    if (!groqKey) {
      setError('Add a Groq API key in Settings to use voice')
      return
    }
    setTranscribing(true)
    try {
      const formData = new FormData()
      formData.append('file', blob, 'recording.webm')
      formData.append('model', 'whisper-large-v3')
      formData.append('response_format', 'json')
      // Hint for mixed Hebrew/English
      formData.append('language', 'he')

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}` },
        body: formData,
      })
      if (!res.ok) throw new Error(`Groq error ${res.status}`)
      const data = await res.json()
      if (data.text) onTranscription(data.text)
    } catch (e) {
      setError('Transcription failed')
      console.error(e)
    } finally {
      setTranscribing(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-red-500">{error}</span>
      )}
      <button
        onPointerDown={startRecording}
        onPointerUp={stopRecording}
        onPointerLeave={recording ? stopRecording : undefined}
        disabled={transcribing}
        title={recording ? 'Release to transcribe' : 'Hold to record'}
        className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
          recording
            ? 'bg-red-500 text-white animate-pulse'
            : transcribing
            ? 'bg-gray-200 dark:bg-gray-600 text-gray-400'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
        }`}
      >
        {transcribing ? (
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
        ) : (
          <MicIcon className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  )
}

function MicIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
}
