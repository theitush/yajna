import { DRIVE_FOLDER_NAME, DRIVE_MIME_FOLDER } from '../lib/constants'
import { getMeta, putMeta } from './db'
import { withAuthRetry } from './auth'
import { sealContent, openContent, getEncStatus, isEncError } from './cryptoBox'

const FOLDER_ID_KEY = 'drive_folder_id'
const FILES_KEY = 'drive_files'
const REVISIONS_KEY = 'drive_revisions'
const API_TIMEOUT_MS = 15_000

/** Wrap a promise with a timeout so Drive API calls can't hang forever. */
function withTimeout(promise, ms = API_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Drive API call timed out')), ms)
    ),
  ])
}

/**
 * fetch wrapper that aborts the request on timeout. Plain Promise.race leaves
 * the underlying request running, which is no help when Firefox has frozen the
 * tab mid-upload — we need AbortController to actually free the slot and let
 * the retry path take over.
 */
async function fetchWithTimeout(url, init = {}, ms = API_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Drive fetch timed out')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wrap a gapi request thunk in both auth retry and timeout. The thunk is
 * re-invoked on retry so the second attempt picks up the refreshed token
 * via gapi.client.setToken (and the multipart fetch helpers below re-read
 * the token from gapi inside their thunks for the same reason).
 */
function gapiCall(makeRequest, ms = API_TIMEOUT_MS) {
  return withAuthRetry(() => withTimeout(makeRequest(), ms))
}

/**
 * Treat a fetch Response with auth failure as a thrown error so withAuthRetry
 * can refresh + retry the whole multipart call.
 */
async function ensureFetchOk(res, label) {
  if (res.ok) return res
  const err = await res.json().catch(() => ({}))
  const error = new Error(err.error?.message || `${label}: ${res.status}`)
  error.status = res.status
  throw error
}

/**
 * Find or create the app root folder in Drive
 */
export async function getOrCreateAppFolder() {
  const cached = await getMeta(FOLDER_ID_KEY)
  if (cached) return cached

  // Search for existing folder
  const res = await gapiCall(() => window.gapi.client.drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='${DRIVE_MIME_FOLDER}' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  }))

  if (res.result.files.length > 0) {
    const id = res.result.files[0].id
    await putMeta(FOLDER_ID_KEY, id)
    return id
  }

  // Create folder
  const created = await gapiCall(() => window.gapi.client.drive.files.create({
    resource: {
      name: DRIVE_FOLDER_NAME,
      mimeType: DRIVE_MIME_FOLDER,
    },
    fields: 'id',
  }))
  const id = created.result.id
  await putMeta(FOLDER_ID_KEY, id)
  return id
}

/**
 * Get or create a subfolder inside the app folder
 */
export async function getOrCreateSubfolder(parentId, name) {
  const res = await gapiCall(() => window.gapi.client.drive.files.list({
    q: `name='${name}' and mimeType='${DRIVE_MIME_FOLDER}' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id)',
  }))
  if (res.result.files.length > 0) return res.result.files[0].id

  const created = await gapiCall(() => window.gapi.client.drive.files.create({
    resource: {
      name,
      mimeType: DRIVE_MIME_FOLDER,
      parents: [parentId],
    },
    fields: 'id',
  }))
  return created.result.id
}

/**
 * Find a file by name in a folder
 */
export async function findFile(parentId, name) {
  const res = await gapiCall(() => window.gapi.client.drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id)',
  }))
  return res.result.files[0]?.id || null
}

/**
 * Read a JSON file from Drive
 */
export async function readJsonFile(fileId) {
  const res = await gapiCall(() => window.gapi.client.drive.files.get({
    fileId,
    alt: 'media',
  }))
  if (typeof res.body === 'string') {
    return JSON.parse(res.body)
  }
  return res.result
}

/**
 * Create or update a JSON file in Drive
 */
export async function writeJsonFile(parentId, name, data, existingFileId = null) {
  const content = JSON.stringify(data, null, 2)
  const blob = new Blob([content], { type: 'application/json' })

  const metadata = {
    name,
    mimeType: 'application/json',
    ...(existingFileId ? {} : { parents: [parentId] }),
  }

  return withAuthRetry(async () => {
    // FormData with a Blob body is single-consumption — rebuild it per attempt
    // so a refresh-and-retry doesn't try to send an already-read stream.
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('media', blob)
    const token = window.gapi.client.getToken()?.access_token

    if (existingFileId) {
      const res = await fetchWithTimeout(
        `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        }
      )
      await ensureFetchOk(res, 'Drive patch failed')
      return existingFileId
    }
    const res = await fetchWithTimeout(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }
    )
    await ensureFetchOk(res, 'Drive create failed')
    const json = await res.json()
    return json.id
  })
}

/**
 * Upload an audio blob to Drive
 */
export async function uploadAudioFile(parentId, name, blob) {
  // Content choke point: seal the raw audio bytes when encryption is on. On a
  // plaintext Drive it's the original blob untouched; on a locked/undetermined
  // device sealContent THROWS (fail closed — never write a plaintext clip onto
  // an encrypted Drive). The stored mimeType flips to octet-stream so Drive
  // can't sniff the container; the real mime rides in the audio meta doc and is
  // re-applied on download.
  let body = blob
  let uploadMime = blob.type || 'audio/webm'
  if (getEncStatus() !== 'plaintext') {
    const raw = new Uint8Array(await blob.arrayBuffer())
    const sealed = await sealContent(raw)
    body = new Blob([sealed], { type: 'application/octet-stream' })
    uploadMime = 'application/octet-stream'
  }
  const metadata = {
    name,
    mimeType: uploadMime,
    parents: [parentId],
  }
  return withAuthRetry(async () => {
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('media', body)
    const token = window.gapi.client.getToken()?.access_token
    const res = await fetchWithTimeout(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
      60_000
    )
    await ensureFetchOk(res, 'Audio upload failed')
    return res.json()
  })
}

/**
 * Permanently delete a file from Drive. Swallows 404 so retries are idempotent.
 */
export async function deleteDriveFile(fileId) {
  if (!fileId) return
  try {
    await gapiCall(() => window.gapi.client.drive.files.delete({ fileId }))
  } catch (e) {
    const status = e?.status || e?.result?.error?.code
    if (status === 404) return
    throw e
  }
}

/**
 * Download a file from Drive as a Blob (used for lazy audio fetch). Sniffs for
 * our envelope and decrypts when sealed; a plaintext straggler passes through.
 * `mimeType` sets the returned Blob's type so audio playback stays correct even
 * though sealed clips are stored as octet-stream (the container mime is hidden
 * on Drive and lives in the audio meta doc instead).
 */
export async function downloadFileBlob(fileId, mimeType = null) {
  return withAuthRetry(async () => {
    const token = window.gapi.client.getToken()?.access_token
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
      60_000
    )
    await ensureFetchOk(res, 'Drive download failed')
    const raw = new Uint8Array(await res.arrayBuffer())
    // openContent decrypts a sealed clip (throws EncLockedError if we have no
    // key), and returns a plaintext straggler unchanged.
    const bytes = await openContent(raw)
    return new Blob([bytes], { type: mimeType || res.headers.get('content-type') || 'application/octet-stream' })
  })
}

/**
 * Initialize the full folder structure and return all file ids
 */
export async function initDriveStructure() {
  const t0 = performance.now()
  const lap = (label, from) => { console.log(`[drive-init] ${label}: ${(performance.now() - from).toFixed(0)}ms`); return performance.now() }

  // If we already have a fully-populated ids cache, skip all the lookups —
  // initDriveStructure on a warm start should be a no-op.
  const cached = await getMeta(FILES_KEY)
  // Cache is only authoritative once it includes the Phase B folders. Old
  // caches from pre-Phase-B installs fall through to the resolver below, which
  // creates the new folders and rewrites the cache. Post-migration the legacy
  // *FileId keys may be null, which is expected.
  if (cached && cached.rootId && cached.journalsFolderId && cached.audioFolderId &&
      cached.notesFolderId && cached.tasksFolderId && cached.audioMetaFolderId &&
      cached.configFolderId && cached.configFileId) {
    lap('cache hit', t0)
    return cached
  }

  let t = performance.now()
  const rootId = await getOrCreateAppFolder(); t = lap('getOrCreateAppFolder', t)
  const [journalsFolderId, audioFolderId, notesFolderId, tasksFolderId, configFolderId] = await Promise.all([
    getOrCreateSubfolder(rootId, 'journals'),
    getOrCreateSubfolder(rootId, 'audio'),
    getOrCreateSubfolder(rootId, 'notes'),
    getOrCreateSubfolder(rootId, 'tasks'),
    getOrCreateSubfolder(rootId, 'config'),
  ]); t = lap('subfolders', t)
  // audio/meta lives under audio/ so audio blobs and metadata share a parent.
  const audioMetaFolderId = await getOrCreateSubfolder(audioFolderId, 'meta')
  t = lap('audio/meta subfolder', t)

  const ensureFile = async (name, defaultData) => {
    let fileId = await findFile(rootId, name)
    if (!fileId) {
      fileId = await writeJsonFile(rootId, name, defaultData)
    }
    return fileId
  }

  // Pre-migration: legacy bulk files still exist and we resolve their ids so
  // the entities migration can read them. We only CREATE them (defaultData) if
  // they're missing AND the migration flag isn't set — once Phase B has run,
  // these files are gone and findFile returns null. The post-migration ids
  // cache drops these keys.
  const entitiesMigrated = !!(await getMeta('entities_split_v1'))

  const findOrEnsureLegacy = async (name, defaultData) => {
    const existing = await findFile(rootId, name)
    if (existing) return existing
    if (entitiesMigrated) return null
    return writeJsonFile(rootId, name, defaultData)
  }

  const [tasksFileId, notesFileId, configFileId, audioIndexFileId] = await Promise.all([
    findOrEnsureLegacy('tasks.json', []),
    findOrEnsureLegacy('notes.json', []),
    ensureFile('config.json', {}),
    findOrEnsureLegacy('audio.json', []),
  ]); lap('ensureFiles', t)

  const ids = {
    rootId, journalsFolderId, audioFolderId, notesFolderId, tasksFolderId, audioMetaFolderId, configFolderId,
    tasksFileId, notesFileId, configFileId, audioIndexFileId,
  }
  await putMeta(FILES_KEY, ids)
  lap('TOTAL initDriveStructure', t0)
  return ids
}

export async function getDriveFileIds() {
  return getMeta(FILES_KEY)
}

/**
 * Fetch headRevisionId for a set of file ids in parallel.
 * Returns { [fileId]: headRevisionId | null }.
 */
export async function getFileRevisions(fileIds) {
  const entries = await Promise.all(fileIds.filter(Boolean).map(async (id) => {
    try {
      const res = await gapiCall(() => window.gapi.client.drive.files.get({
        fileId: id,
        fields: 'headRevisionId',
      }))
      return [id, res.result?.headRevisionId || null]
    } catch {
      return [id, null]
    }
  }))
  return Object.fromEntries(entries)
}

export async function getStoredRevisions() {
  return (await getMeta(REVISIONS_KEY)) || {}
}

export async function setStoredRevisions(revs) {
  await putMeta(REVISIONS_KEY, revs)
}

/**
 * List all files in a Drive folder (id + name + modifiedTime + mimeType),
 * paginated. Used by Phase B cold-start enumeration when the local manifest
 * seq is too far behind the remote ring, and by the encryption migration/audit
 * (mimeType lets them skip subfolders — e.g. audio/ contains the meta/ folder).
 */
export async function listFolder(folderId) {
  const out = []
  let pageToken = undefined
  do {
    const res = await gapiCall(() => window.gapi.client.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, modifiedTime, mimeType)',
      pageToken,
      pageSize: 200,
    }))
    for (const f of res.result.files || []) out.push(f)
    pageToken = res.result.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Per-entity helpers. Filenames are `<id>.json` inside the entity folder.
 * Each helper returns null on missing-file rather than throwing so cold-start
 * enumeration can be tolerant.
 *
 * Transport is the BINARY path (readBinaryFile/writeBinaryFile), not the JSON
 * helpers, so this content (audio metadata — full transcripts) flows through
 * the seal/open envelope like the `.bin` docs. The bytes are still JSON: the
 * filename stays `<id>.json` and old plaintext files (written as
 * application/json) read back fine — readBinaryFile fetches raw bytes either
 * way and openContent passes an unsealed straggler through unchanged.
 */
export async function readEntityFile(folderId, id) {
  const fileId = await findFile(folderId, `${id}.json`)
  if (!fileId) return null
  try {
    const raw = await readBinaryFile(fileId)
    const bytes = await openContent(raw)
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (e) {
    // Rethrow enc errors (a locked device / unopenable ciphertext) so the read
    // aborts instead of masquerading as a missing file; anything else keeps the
    // tolerant null-on-failure contract for cold-start enumeration.
    if (isEncError(e)) throw e
    return null
  }
}

export async function writeEntityFile(folderId, id, data) {
  const filename = `${id}.json`
  const existing = await findFile(folderId, filename)
  const plain = new TextEncoder().encode(JSON.stringify(data, null, 2))
  const payload = await sealContent(plain) // seal when unlocked; throw when keyless
  return writeBinaryFile(folderId, filename, payload, existing)
}

/**
 * Read many entity files in batches. Drive rate limits are generous but a
 * 500-task cold start firing all in parallel can trigger 429s. Batches of 20
 * keep things fast without poking the limit. Returns an array of
 * { id, doc } in input order; doc is null on failure.
 *
 * `entries` is [{ id, fileId? }]. If fileId is provided we skip the lookup;
 * otherwise we resolve by name inside `folderId`. Same binary+envelope transport
 * as readEntityFile.
 */
export async function readEntityFilesBatched(folderId, entries, batchSize = 20, onBatch = null) {
  const out = []
  for (let i = 0; i < entries.length; i += batchSize) {
    const slice = entries.slice(i, i + batchSize)
    const results = await Promise.all(slice.map(async ({ id, fileId }) => {
      try {
        const fid = fileId || await findFile(folderId, `${id}.json`)
        if (!fid) return { id, doc: null }
        const raw = await readBinaryFile(fid)
        const bytes = await openContent(raw)
        const doc = JSON.parse(new TextDecoder().decode(bytes))
        return { id, doc }
      } catch (e) {
        // An enc lock must abort the whole merge, not become a floor-held hole —
        // rethrow so Promise.all rejects. Everything else carries the error out
        // instead of folding "fetch failed" into "file missing" so callers don't
        // advance their seq floor past a change they couldn't read.
        if (isEncError(e)) throw e
        return { id, doc: null, err: String(e?.message || e).slice(0, 140) }
      }
    }))
    out.push(...results)
    if (onBatch) {
      try { onBatch(out.length, entries.length) } catch { /* ignore */ }
    }
  }
  return out
}

/**
 * Binary file helpers — Phase C. Automerge documents are saved as opaque
 * Uint8Array blobs; we upload them as application/octet-stream so Drive
 * preserves them byte-for-byte and doesn't try to re-encode.
 */
export async function readBinaryFile(fileId, timeoutMs = API_TIMEOUT_MS) {
  return withAuthRetry(async () => {
    const token = window.gapi.client.getToken()?.access_token
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
      timeoutMs
    )
    await ensureFetchOk(res, 'Drive binary download failed')
    const buf = await res.arrayBuffer()
    return new Uint8Array(buf)
  })
}

/**
 * Read just the first `n` bytes of a file via an HTTP Range request. The
 * encryption audit sniffs hundreds of files for the envelope magic; pulling
 * 16 bytes each instead of whole documents/audio blobs is the difference
 * between seconds and minutes. Drive honors Range on alt=media (206); if a
 * proxy ever ignores it and returns the full body, we slice locally.
 */
export async function readFileHead(fileId, n = 16) {
  return withAuthRetry(async () => {
    const token = window.gapi.client.getToken()?.access_token
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}`, Range: `bytes=0-${n - 1}` } }
    )
    await ensureFetchOk(res, 'Drive head read failed')
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.length > n ? bytes.subarray(0, n) : bytes
  })
}

export async function writeBinaryFile(parentId, name, bytes, existingFileId = null, timeoutMs = API_TIMEOUT_MS) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const metadata = {
    name,
    mimeType: 'application/octet-stream',
    ...(existingFileId ? {} : { parents: [parentId] }),
  }
  return withAuthRetry(async () => {
    // FormData with a Blob body is single-consumption — rebuild per attempt.
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('media', blob)
    const token = window.gapi.client.getToken()?.access_token
    if (existingFileId) {
      const res = await fetchWithTimeout(
        `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: form },
        timeoutMs
      )
      await ensureFetchOk(res, 'Drive binary patch failed')
      return existingFileId
    }
    const res = await fetchWithTimeout(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
      timeoutMs
    )
    await ensureFetchOk(res, 'Drive binary create failed')
    const json = await res.json()
    return json.id
  })
}

/**
 * Per-entity binary helpers. Filename is `<id>.bin`. Returns null on missing
 * file so cold-start callers can be tolerant; a failed DOWNLOAD throws — the
 * batched readers' rule, so callers can tell "not there" from "couldn't read"
 * (most wrap with .catch(() => null) when they don't care).
 */
export async function readEntityBinFile(folderId, id) {
  const fileId = await findFile(folderId, `${id}.bin`)
  if (!fileId) return null
  const raw = await readBinaryFile(fileId)
  // Decrypt sealed content (throws EncLockedError with no key, EncCorruptError
  // on the wrong key); a plaintext straggler passes through. Push-side callers
  // wrap this in `.catch` — those catches rethrow enc errors (see sync.js) so a
  // keyless read can't be mistaken for "no remote" and clobbered.
  return openContent(raw)
}

export async function writeEntityBinFile(folderId, id, bytes) {
  const filename = `${id}.bin`
  const existing = await findFile(folderId, filename)
  const payload = await sealContent(bytes) // seal when unlocked; throw when keyless
  return writeBinaryFile(folderId, filename, payload, existing)
}

/**
 * Batched binary reader. Mirrors readEntityFilesBatched but for `.bin` files.
 * `entries` is [{ id, fileId? }]. Returns [{ id, bytes }]; bytes null on miss.
 */
export async function readEntityBinFilesBatched(folderId, entries, batchSize = 20, onBatch = null) {
  const out = []
  for (let i = 0; i < entries.length; i += batchSize) {
    const slice = entries.slice(i, i + batchSize)
    const results = await Promise.all(slice.map(async ({ id, fileId }) => {
      try {
        const fid = fileId || await findFile(folderId, `${id}.bin`)
        if (!fid) return { id, bytes: null }
        const raw = await readBinaryFile(fid)
        const bytes = await openContent(raw)
        return { id, bytes }
      } catch (e) {
        // An enc lock aborts the merge — rethrow so Promise.all rejects rather
        // than turning unreadable sealed content into a floor-held null hole.
        // Everything else: distinguish read failure from a genuinely missing
        // file for callers' floor-hold and probes.
        if (isEncError(e)) throw e
        return { id, bytes: null, err: String(e?.message || e).slice(0, 140) }
      }
    }))
    out.push(...results)
    if (onBatch) {
      try { onBatch(out.length, entries.length) } catch { /* ignore */ }
    }
  }
  return out
}
