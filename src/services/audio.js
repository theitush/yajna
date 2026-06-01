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
  getDriveFileIds, downloadFileBlob, deleteDriveFile,
  readJsonFile, writeEntityFile, readEntityFile, listFolder,
} from './drive'
import { appendChanges, getDeviceId } from './manifest'
import { withAuthRetry } from './auth'
import { queueAudioPush } from './swClient'
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
 * Ensure a local blob exists for this audio id. If the blob is missing locally
 * but the Drive index has it, lazy-download it now. Returns the record or null.
 */
export async function ensureAudioLocal(id, hints = null, opts = null) {
  const metaOnly = !!opts?.metaOnly
  const local = await getAudio(id)
  if (local?.blob && !metaOnly) return local

  const ids = await getDriveFileIds()
  if (!ids) {
    logSync('audio ensure: no drive ids', { id })
    return local || null
  }

  // driveFileId resolution order:
  //   1. caller hint (the document node — the new source of truth)
  //   2. local IDB record (origin device, or already-downloaded)
  //   3. legacy audio/meta/<id>.json (pre-migration clips not yet backfilled)
  //   4. surviving audio/<id>.<ext> blob by name (orphan recovery)
  let driveFileId = hints?.driveFileId || local?.driveFileId || null
  let mimeType = hints?.mimeType || local?.mimeType || 'audio/webm'
  let createdAt = hints?.createdAt || local?.createdAt || null
  let transcript = local?.transcript || null
  let transcriptModel = local?.transcriptModel || null
  let transcribedAt = local?.transcribedAt || null
  let transcriptSegments = local?.transcriptSegments || null

  if (!driveFileId) {
    let entry = null
    if (ids.audioMetaFolderId) {
      entry = await readEntityFile(ids.audioMetaFolderId, id)
    }
    if (!entry && ids.audioIndexFileId) {
      const remoteIndex = await readJsonFile(ids.audioIndexFileId).catch(() => [])
      entry = Array.isArray(remoteIndex) ? remoteIndex.find(e => e.id === id) : null
    }
    if (entry?.driveFileId) {
      driveFileId = entry.driveFileId
      mimeType = entry.mimeType || mimeType
      createdAt = createdAt || entry.createdAt || null
      transcript = transcript || entry.transcript || null
      transcriptModel = transcriptModel || entry.transcriptModel || null
      transcribedAt = transcribedAt || entry.transcribedAt || null
      transcriptSegments = transcriptSegments || entry.transcriptSegments || null
    } else {
      // Last resort: the blob may exist under audio/<id>.<ext> with no meta.
      driveFileId = await findAudioBlobFileId(ids.audioFolderId, id)
    }
  }

  if (!driveFileId) {
    logSync('audio ensure: give up (no driveFileId)', { id, hadHint: !!hints?.driveFileId })
    return local || null
  }

  // metaOnly: caller just wants legacy transcript/createdAt for backfill — don't
  // pay for a blob download.
  if (metaOnly) {
    return { id, mimeType, duration: local?.duration || 0, createdAt, driveFileId, transcript, transcriptModel, transcribedAt, transcriptSegments }
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
 * Find the Drive fileId of an audio blob named `<id>.<ext>` in audio/. Returns
 * null if none exists. Used as a recovery fallback when a node has no
 * driveFileId and no meta file survives.
 */
async function findAudioBlobFileId(audioFolderId, id) {
  if (!audioFolderId) return null
  try {
    const files = await listFolder(audioFolderId)
    const m = files.find(f => new RegExp(`^${id}\\.(webm|ogg|mp3|m4a|mp4|wav|aac)$`, 'i').test(f.name || ''))
    return m?.id || null
  } catch {
    return null
  }
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
 * Serialize an audio record into the document-node HTML form. Single source of
 * truth for the `<div data-audio-id ...>` shape so restore/trash paths stay in
 * sync with AudioNode's renderHTML. Carries the full node-attr metadata so the
 * reference is self-sufficient (no audio/meta side file).
 */
export function audioBlockHtml(rec) {
  if (!rec?.id) return ''
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let out = `<div data-audio-id="${esc(rec.id)}" data-duration="${rec.duration || 0}"`
  if (rec.createdAt) out += ` data-created-at="${esc(rec.createdAt)}"`
  if (rec.driveFileId) out += ` data-drive-file-id="${esc(rec.driveFileId)}"`
  if (rec.mimeType) out += ` data-mime-type="${esc(rec.mimeType)}"`
  if (rec.transcript) out += ` data-transcript="${esc(rec.transcript)}"`
  if (rec.transcriptModel) out += ` data-transcript-model="${esc(rec.transcriptModel)}"`
  if (rec.transcribedAt) out += ` data-transcribed-at="${esc(rec.transcribedAt)}"`
  if (Array.isArray(rec.transcriptSegments) && rec.transcriptSegments.length) {
    out += ` data-transcript-segments="${esc(JSON.stringify(rec.transcriptSegments))}"`
  }
  out += '></div>'
  return out
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
        // Route through the SW push queue (same as a fresh recording): wakes
        // the SW where available, falls back to a page upload otherwise.
        await queueAudioPush(rec.id)
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
