/**
 * Audio: local-first blob storage with lazy Drive sync.
 *
 * Model:
 * - Blob lives in IDB (STORE_AUDIO). This is the source of truth for playback.
 * - Each record has an optional driveFileId once it's been uploaded.
 * - audio.json in Drive is a light index of { id, driveFileId, mimeType, createdAt }
 *   so other devices know what exists and can lazy-download on play.
 */
import { putAudio, getAudio, getAllAudio } from './db'
import {
  getDriveFileIds, uploadAudioFile, downloadFileBlob,
  readJsonFile, writeJsonFile,
} from './drive'

function toIndexEntry(rec) {
  return {
    id: rec.id,
    driveFileId: rec.driveFileId || null,
    mimeType: rec.mimeType || 'audio/webm',
    duration: rec.duration || 0,
    createdAt: rec.createdAt,
    transcript: rec.transcript || null,
    transcriptModel: rec.transcriptModel || null,
    transcribedAt: rec.transcribedAt || null,
    transcriptSegments: rec.transcriptSegments || null,
  }
}

/**
 * Upload a local audio record to Drive and update the audio.json index.
 * Safe to call when offline — will just no-op.
 */
export async function pushAudio(id) {
  const ids = await getDriveFileIds()
  if (!ids || !ids.audioFolderId) return
  const rec = await getAudio(id)
  if (!rec || !rec.blob) return
  if (rec.driveFileId) return // already uploaded

  const ext = (rec.mimeType || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm'
  const filename = `${id}.${ext}`
  const uploaded = await uploadAudioFile(ids.audioFolderId, filename, rec.blob)
  if (!uploaded?.id) return

  const updated = { ...rec, driveFileId: uploaded.id, uploadedAt: new Date().toISOString() }
  await putAudio(updated)

  // Update audio.json index (merge with remote so concurrent uploads don't clobber)
  const remoteIndex = await readJsonFile(ids.audioIndexFileId).catch(() => [])
  const index = Array.isArray(remoteIndex) ? remoteIndex : []
  const filtered = index.filter(e => e.id !== id)
  filtered.push(toIndexEntry(updated))
  await writeJsonFile(ids.rootId, 'audio.json', filtered, ids.audioIndexFileId)
}

/**
 * Push an updated audio metadata record (e.g. after transcription) into audio.json.
 * The local IDB record must already be saved. No-op when offline.
 */
export async function pushAudioMetadata(id) {
  const ids = await getDriveFileIds()
  if (!ids || !ids.audioFolderId) return
  const rec = await getAudio(id)
  if (!rec) return

  const remoteIndex = await readJsonFile(ids.audioIndexFileId).catch(() => [])
  const index = Array.isArray(remoteIndex) ? remoteIndex : []
  const filtered = index.filter(e => e.id !== id)
  filtered.push(toIndexEntry(rec))
  await writeJsonFile(ids.rootId, 'audio.json', filtered, ids.audioIndexFileId)
}

/**
 * Ensure a local blob exists for this audio id. If the blob is missing locally
 * but the Drive index has it, lazy-download it now. Returns the record or null.
 */
export async function ensureAudioLocal(id) {
  const local = await getAudio(id)
  if (local?.blob) return local

  const ids = await getDriveFileIds()
  if (!ids) return local || null

  // Look up driveFileId — prefer local record, fall back to remote index
  let driveFileId = local?.driveFileId
  let mimeType = local?.mimeType || 'audio/webm'
  let createdAt = local?.createdAt
  let transcript = local?.transcript || null
  let transcriptModel = local?.transcriptModel || null
  let transcribedAt = local?.transcribedAt || null
  let transcriptSegments = local?.transcriptSegments || null
  if (!driveFileId) {
    const remoteIndex = await readJsonFile(ids.audioIndexFileId).catch(() => [])
    const entry = Array.isArray(remoteIndex) ? remoteIndex.find(e => e.id === id) : null
    if (!entry?.driveFileId) return local || null
    driveFileId = entry.driveFileId
    mimeType = entry.mimeType || mimeType
    createdAt = entry.createdAt || new Date().toISOString()
    transcript = transcript || entry.transcript || null
    transcriptModel = transcriptModel || entry.transcriptModel || null
    transcribedAt = transcribedAt || entry.transcribedAt || null
    transcriptSegments = transcriptSegments || entry.transcriptSegments || null
  }

  const blob = await downloadFileBlob(driveFileId)
  const record = {
    id,
    blob,
    mimeType,
    duration: local?.duration || 0,
    createdAt: createdAt || new Date().toISOString(),
    driveFileId,
    transcript,
    transcriptModel,
    transcribedAt,
    transcriptSegments,
  }
  await putAudio(record)
  return record
}

/**
 * On initial sync / reconnect: upload any local blobs that don't have a driveFileId.
 * Lazy downloads are handled on-demand when a node tries to play, so we don't
 * pre-fetch remote blobs here.
 */
export async function pushPendingAudio() {
  const all = await getAllAudio()
  for (const rec of all) {
    if (!rec.driveFileId && rec.blob) {
      try {
        await pushAudio(rec.id)
      } catch (e) {
        console.warn('Audio upload failed', rec.id, e)
      }
    }
  }
}
