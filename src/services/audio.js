/**
 * Audio: local-first blob storage with lazy Drive sync.
 *
 * Model:
 * - Blob lives in IDB (STORE_AUDIO). This is the source of truth for playback.
 * - Each record has an optional driveFileId once it's been uploaded.
 * - audio.json in Drive is a light index of { id, driveFileId, mimeType, createdAt }
 *   so other devices know what exists and can lazy-download on play.
 */
import { putAudio, getAudio, getAllAudio, deleteAudio as dbDeleteAudio } from './db'
import {
  getDriveFileIds, uploadAudioFile, downloadFileBlob, deleteDriveFile,
  readJsonFile, writeJsonFile, writeEntityFile, readEntityFile, listFolder,
} from './drive'
import { appendChanges, getDeviceId } from './manifest'
import { withAuthRetry } from './auth'
import { logSync } from './syncLog'

/**
 * Phase B: per-id audio metadata. Each upsert merges with the remote file
 * (transcripts never get dropped because of stale in-memory state) and
 * appends a manifest entry.
 */
async function upsertAudioMeta(ids, entry) {
  if (!ids?.audioMetaFolderId) return
  const remote = await readEntityFile(ids.audioMetaFolderId, entry.id)
  const merged = remote
    ? {
        ...remote,
        ...entry,
        transcript: entry.transcript ?? remote.transcript ?? null,
        transcriptModel: entry.transcriptModel ?? remote.transcriptModel ?? null,
        transcribedAt: entry.transcribedAt ?? remote.transcribedAt ?? null,
        transcriptSegments: entry.transcriptSegments ?? remote.transcriptSegments ?? null,
      }
    : entry
  await writeEntityFile(ids.audioMetaFolderId, entry.id, merged)
  try {
    await appendChanges(ids.rootId, [{
      type: 'audio',
      id: entry.id,
      op: merged.deleted ? 'delete' : 'upsert',
      at: new Date().toISOString(),
      deviceId: await getDeviceId(),
    }])
  } catch (e) {
    console.warn('[audio] manifest append failed (entity file still authoritative):', e.message || e)
  }
}

async function removeAudioMeta(ids, id) {
  if (!ids?.audioMetaFolderId) return
  // Hard-delete: drop the per-id meta file. Manifest entry records the delete
  // so other devices know to drop their local copy.
  const existing = await readEntityFile(ids.audioMetaFolderId, id)
  if (existing) {
    // Drive doesn't expose deleteByName, so we need the actual fileId.
    try {
      const res = await withAuthRetry(() => window.gapi.client.drive.files.list({
        q: `name='${id}.json' and '${ids.audioMetaFolderId}' in parents and trashed=false`,
        fields: 'files(id)',
      }))
      const fid = res.result.files?.[0]?.id
      if (fid) await deleteDriveFile(fid)
    } catch (e) {
      console.warn('[audio] meta delete failed:', e.message || e)
    }
  }
  try {
    await appendChanges(ids.rootId, [{
      type: 'audio',
      id,
      op: 'delete',
      at: new Date().toISOString(),
      deviceId: await getDeviceId(),
    }])
  } catch {}
}

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
    deleted: rec.deleted || false,
    deletedAt: rec.deletedAt || null,
    sourceType: rec.sourceType || null,
    sourceId: rec.sourceId || null,
    sourceTitle: rec.sourceTitle || null,
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
  // Re-read after write: transcription may have landed while upload was in flight.
  const latest = await getAudio(id)

  // Update audio.json index (merge with remote so concurrent uploads don't clobber)
  await upsertAudioMeta(ids, toIndexEntry(latest || updated))
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

  await upsertAudioMeta(ids, toIndexEntry(rec))
}

/**
 * Ensure a local blob exists for this audio id. If the blob is missing locally
 * but the Drive index has it, lazy-download it now. Returns the record or null.
 */
export async function ensureAudioLocal(id) {
  const local = await getAudio(id)
  if (local?.blob) return local

  const ids = await getDriveFileIds()
  if (!ids) {
    logSync('audio ensure: no drive ids', { id })
    return local || null
  }
  logSync('audio ensure: start', {
    id,
    hasLocal: !!local,
    localDriveFileId: local?.driveFileId || null,
    localHasTranscript: !!local?.transcript,
    audioMetaFolderId: ids.audioMetaFolderId || null,
    audioIndexFileId: ids.audioIndexFileId || null,
  })

  // Look up driveFileId — prefer local record, fall back to remote index
  let driveFileId = local?.driveFileId
  let mimeType = local?.mimeType || 'audio/webm'
  let createdAt = local?.createdAt
  let transcript = local?.transcript || null
  let transcriptModel = local?.transcriptModel || null
  let transcribedAt = local?.transcribedAt || null
  let transcriptSegments = local?.transcriptSegments || null
  if (!driveFileId) {
    // Phase B: per-id meta file. Falls back to legacy audio.json during the
    // brief migration window (entitiesMigration deletes audio.json only after
    // every per-id write succeeds).
    let entry = null
    if (ids.audioMetaFolderId) {
      entry = await readEntityFile(ids.audioMetaFolderId, id)
      logSync('audio ensure: meta file lookup', {
        id, found: !!entry, hasDriveFileId: !!entry?.driveFileId, hasTranscript: !!entry?.transcript,
      })
    }
    if (!entry && ids.audioIndexFileId) {
      const remoteIndex = await readJsonFile(ids.audioIndexFileId).catch(() => [])
      entry = Array.isArray(remoteIndex) ? remoteIndex.find(e => e.id === id) : null
      logSync('audio ensure: legacy index fallback', {
        id, indexLen: Array.isArray(remoteIndex) ? remoteIndex.length : -1, found: !!entry,
      })
    }
    if (!entry?.driveFileId) {
      logSync('audio ensure: give up (no driveFileId)', { id })
      return local || null
    }
    driveFileId = entry.driveFileId
    mimeType = entry.mimeType || mimeType
    createdAt = entry.createdAt || new Date().toISOString()
    transcript = transcript || entry.transcript || null
    transcriptModel = transcriptModel || entry.transcriptModel || null
    transcribedAt = transcribedAt || entry.transcribedAt || null
    transcriptSegments = transcriptSegments || entry.transcriptSegments || null
  }

  let blob
  try {
    blob = await downloadFileBlob(driveFileId)
  } catch (e) {
    throw new Error('You need to connect to download the audio.')
  }
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
 * Soft-delete: mark the audio record as trashed and propagate via audio.json.
 * The blob stays in IDB and in Drive so the user can still play it from Trash.
 */
export async function softDeleteAudio(id, source) {
  const rec = await getAudio(id)
  if (!rec) return null
  const now = new Date().toISOString()
  const updated = {
    ...rec,
    deleted: true,
    deletedAt: now,
    sourceType: source?.sourceType || rec.sourceType || null,
    sourceId: source?.sourceId || rec.sourceId || null,
    sourceTitle: source?.sourceTitle || rec.sourceTitle || null,
  }
  await putAudio(updated)

  const ids = await getDriveFileIds()
  if (!ids?.audioMetaFolderId) return updated
  try {
    await upsertAudioMeta(ids, toIndexEntry(updated))
  } catch (e) {
    console.warn('softDeleteAudio meta push failed', e)
  }
  return updated
}

/**
 * Restore a soft-deleted audio record.
 */
export async function restoreAudio(id) {
  const rec = await getAudio(id)
  if (!rec) return null
  const updated = { ...rec, deleted: false, deletedAt: null }
  await putAudio(updated)
  const ids = await getDriveFileIds()
  if (!ids?.audioMetaFolderId) return updated
  try {
    await upsertAudioMeta(ids, toIndexEntry(updated))
  } catch (e) {
    console.warn('restoreAudio meta push failed', e)
  }
  return updated
}

/**
 * Hard-delete: remove the blob from IDB, the file from Drive, and the entry
 * from audio.json. Called from the Trash screen's "Delete permanently".
 */
export async function hardDeleteAudio(id) {
  const rec = await getAudio(id)
  await dbDeleteAudio(id)
  const ids = await getDriveFileIds()
  if (!ids) return
  if (rec?.driveFileId) {
    try { await deleteDriveFile(rec.driveFileId) } catch (e) { console.warn('Drive audio delete failed', e) }
  }
  if (ids.audioMetaFolderId) {
    try {
      await removeAudioMeta(ids, id)
    } catch (e) {
      console.warn('hardDeleteAudio meta push failed', e)
    }
  }
}

/**
 * One-shot repair: reconstruct missing `audio/meta/<id>.json` files from the
 * surviving `audio/<id>.<ext>` blobs on Drive.
 *
 * Context: some pre-migration audios lost their metadata (the entities
 * migration didn't carry their `audio.json` entry into `audio/meta/`), but the
 * blob files in `audio/` are intact. Their filenames are `<id>.<ext>`, so we can
 * map filename → id and re-point a fresh meta entry at the existing blob's
 * Drive fileId. Transcripts for these are unrecoverable (they lived only in the
 * lost meta) but playback is restored.
 *
 * Pass { apply: true } to actually write. Default is a dry run that reports what
 * it would do. Temporary recovery aid.
 */
export async function repairOrphanAudioMeta({ apply = false } = {}) {
  const ids = await getDriveFileIds()
  if (!ids?.audioFolderId || !ids?.audioMetaFolderId) {
    return { error: 'Drive folders not provisioned' }
  }
  const [blobFiles, metaFiles] = await Promise.all([
    listFolder(ids.audioFolderId),
    listFolder(ids.audioMetaFolderId),
  ])
  const metaIds = new Set(
    metaFiles
      .map(f => /^(.+)\.json$/.exec(f.name || '')?.[1])
      .filter(x => x && !x.startsWith('_'))
  )
  // Blobs in audio/ are named `<id>.<ext>`. Skip the nested `meta` folder and
  // any non-blob entries.
  const orphans = []
  for (const f of blobFiles) {
    const m = /^(.+)\.(webm|ogg|mp3|m4a|mp4|wav|aac)$/i.exec(f.name || '')
    if (!m) continue
    const id = m[1]
    if (id.startsWith('_')) continue
    if (metaIds.has(id)) continue
    orphans.push({ id, ext: m[2].toLowerCase(), driveFileId: f.id })
  }

  const result = { totalBlobs: blobFiles.length, existingMeta: metaIds.size, orphans: orphans.length, repaired: 0, failed: [], apply }
  if (!apply) {
    console.log('[audio-repair] DRY RUN —', result)
    console.table(orphans)
    return { ...result, orphanList: orphans }
  }

  const extToMime = { webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac' }
  for (const o of orphans) {
    const entry = {
      id: o.id,
      driveFileId: o.driveFileId,
      mimeType: extToMime[o.ext] || 'audio/webm',
      duration: 0,
      createdAt: new Date().toISOString(),
      transcript: null,
      transcriptModel: null,
      transcribedAt: null,
      transcriptSegments: null,
      deleted: false,
      deletedAt: null,
      sourceType: null,
      sourceId: null,
      sourceTitle: null,
      recoveredAt: new Date().toISOString(),
    }
    try {
      await upsertAudioMeta(ids, entry)
      result.repaired++
    } catch (e) {
      result.failed.push({ id: o.id, error: e.message || String(e) })
    }
  }
  console.log('[audio-repair] APPLIED —', result)
  return result
}

/**
 * Collect all audio ids referenced by a note or journal-entry HTML blob list.
 */
export function collectAudioIdsFromBlocks(blocks) {
  const ids = []
  if (!Array.isArray(blocks)) return ids
  const container = document.createElement('div')
  for (const b of blocks) {
    if (!b?.html || b.deleted) continue
    container.innerHTML = b.html
    for (const el of container.querySelectorAll('[data-audio-id]')) {
      const id = el.getAttribute('data-audio-id')
      if (id) ids.push(id)
    }
  }
  return ids
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

if (typeof window !== 'undefined') {
  // Recovery aid: window.repairOrphanAudioMeta()        -> dry run
  //               window.repairOrphanAudioMeta(true)    -> apply
  window.repairOrphanAudioMeta = (apply = false) => repairOrphanAudioMeta({ apply })
}
