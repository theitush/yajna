const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

export const GROQ_MODELS = [
  { id: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo (fast)' },
  { id: 'whisper-large-v3', label: 'whisper-large-v3 (accurate)' },
  { id: 'distil-whisper-large-v3-en', label: 'distil-whisper-large-v3-en (English only)' },
]

export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo'

export async function transcribeWithGroq({ blob, apiKey, model = DEFAULT_GROQ_MODEL, language }) {
  if (!apiKey) throw new Error('Missing Groq API key')
  if (!blob) throw new Error('Missing audio')

  const ext = (blob.type || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm'
  const file = new File([blob], `audio.${ext}`, { type: blob.type || 'audio/webm' })

  const form = new FormData()
  form.append('file', file)
  form.append('model', model)
  form.append('response_format', 'json')
  if (language) form.append('language', language)

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    let msg = `Groq ${res.status}`
    try {
      const err = await res.json()
      msg = err?.error?.message || msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }

  const data = await res.json()
  return data.text || ''
}
