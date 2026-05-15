import { config } from './config.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

// Transcribe an audio buffer via Groq's Whisper API.
//
//   buffer    — Buffer | Uint8Array of the audio bytes
//   filename  — original filename (used to set the form-data filename and let
//               Groq infer the format)
//   mimeType  — optional MIME type (e.g. 'audio/webm'); falls back to 'audio/webm'
//
// Returns the transcript as a trimmed string. Throws on auth, network, or
// API errors with a short message suitable for surfacing in chat.
export async function transcribeAudio({ buffer, filename, mimeType }) {
  if (!config.groq.apiKey) {
    throw new Error('GROQ_API_KEY not set in .env')
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('empty audio buffer')
  }

  const form = new FormData()
  const blob = new Blob([buffer], { type: mimeType || 'audio/webm' })
  form.append('file', blob, filename || 'audio.webm')
  form.append('model', config.groq.sttModel)
  form.append('response_format', 'text')

  let res
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groq.apiKey}` },
      body: form,
    })
  } catch (err) {
    throw new Error(`Groq transcription network error: ${err.message}`)
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const tail = errBody.slice(0, 300).replace(/\s+/g, ' ').trim()
    throw new Error(`Groq transcription failed (HTTP ${res.status}): ${tail}`)
  }

  const text = await res.text()
  return text.trim()
}
