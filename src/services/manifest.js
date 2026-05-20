/**
 * manifest.json: append-only changelog of entity changes (notes/tasks/audio).
 *
 * Shape:
 *   {
 *     version: 1,
 *     seq: <max changes[].seq>,
 *     compactedAt: <iso | null>,
 *     changes: [
 *       { seq, type: 'note'|'task'|'audio', id, op: 'upsert'|'delete', at, deviceId }
 *     ]
 *   }
 *
 * Invariants:
 *   - `changes` is append-only between compactions; capped at MAX_ENTRIES.
 *   - The manifest is a HINT for poll efficiency, NOT source of truth. The
 *     per-entity files in notes/, tasks/, audio/meta/ are authoritative.
 *     A lost manifest write only delays cross-device discovery — the per-entity
 *     file is still written and a cold-start full-list pass recovers it.
 *   - Append uses Drive `If-Match` on headRevisionId. On 412 we re-read and
 *     retry up to MAX_APPEND_RETRIES.
 *   - Compaction runs opportunistically when length exceeds MAX_ENTRIES. It is
 *     idempotent; if contended, give up and let the next device try.
 */
import { getMeta, putMeta } from './db'
import { readJsonFile, findFile } from './drive'
import { withAuthRetry } from './auth'

const MANIFEST_FILENAME = 'manifest.json'
const MAX_ENTRIES = 500
const COMPACT_KEEP_HOURS = 24
const MAX_APPEND_RETRIES = 5
const DEVICE_ID_KEY = 'device_id'
const LAST_SEQ_KEY = 'manifest_last_seq'
const API_TIMEOUT_MS = 15_000

function withTimeout(promise, ms = API_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Drive API call timed out')), ms)),
  ])
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * Stable per-install identifier. Random on first call, persisted in IDB meta.
 */
export async function getDeviceId() {
  let id = await getMeta(DEVICE_ID_KEY)
  if (id) return id
  id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `d_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  await putMeta(DEVICE_ID_KEY, id)
  return id
}

/**
 * Highest manifest seq this device has applied. Used to diff incoming changes
 * on poll. Reset to 0 if the local IDB is wiped.
 */
export async function getLocalLastSeq() {
  return (await getMeta(LAST_SEQ_KEY)) || 0
}

export async function setLocalLastSeq(seq) {
  await putMeta(LAST_SEQ_KEY, seq)
}

export function emptyManifest() {
  return { version: 1, seq: 0, compactedAt: null, changes: [] }
}

function isValidManifest(m) {
  return m && typeof m === 'object' && Array.isArray(m.changes) && typeof m.seq === 'number'
}

/**
 * Look up the manifest file in Drive. Returns { fileId, headRevisionId } or
 * null if the file doesn't exist yet (pre-migration).
 */
async function getManifestFileMeta(rootId) {
  const res = await withAuthRetry(() => withTimeout(window.gapi.client.drive.files.list({
    q: `name='${MANIFEST_FILENAME}' and '${rootId}' in parents and trashed=false`,
    fields: 'files(id, headRevisionId)',
  })))
  const f = res.result.files?.[0]
  return f ? { fileId: f.id, headRevisionId: f.headRevisionId || null } : null
}

/**
 * Read the manifest from Drive. Returns { manifest, fileId, headRevisionId }
 * or null if the file doesn't exist. Tolerates malformed bodies by returning
 * an empty manifest in their place — caller decides whether to overwrite.
 */
export async function readManifest(rootId) {
  const meta = await getManifestFileMeta(rootId)
  if (!meta) return null
  const body = await readJsonFile(meta.fileId)
  const manifest = isValidManifest(body) ? body : emptyManifest()
  return { manifest, fileId: meta.fileId, headRevisionId: meta.headRevisionId }
}

/**
 * Write a manifest with optimistic concurrency via If-Match. Returns
 * { ok: true, headRevisionId } on success or { ok: false, conflict: true }
 * on 412. Other errors throw.
 */
async function writeManifestWithIfMatch(fileId, manifest, ifMatchRevision) {
  return withAuthRetry(async () => {
    const token = window.gapi.client.getToken()?.access_token
    const headers = { Authorization: `Bearer ${token}` }
    if (ifMatchRevision) headers['If-Match'] = ifMatchRevision
    const form = new FormData()
    form.append('metadata', new Blob(
      [JSON.stringify({ name: MANIFEST_FILENAME, mimeType: 'application/json' })],
      { type: 'application/json' }
    ))
    form.append('media', new Blob([JSON.stringify(manifest)], { type: 'application/json' }))
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,headRevisionId`,
      { method: 'PATCH', headers, body: form }
    )
    if (res.status === 412) return { ok: false, conflict: true }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const error = new Error(err.error?.message || `Manifest write failed: ${res.status}`)
      error.status = res.status
      throw error
    }
    const json = await res.json()
    return { ok: true, headRevisionId: json.headRevisionId || null }
  })
}

/**
 * Create the manifest file (no If-Match — file doesn't exist yet). Used by
 * the entities migration on first run.
 */
export async function createManifest(rootId, manifest = emptyManifest()) {
  return withAuthRetry(async () => {
    const token = window.gapi.client.getToken()?.access_token
    const form = new FormData()
    form.append('metadata', new Blob(
      [JSON.stringify({ name: MANIFEST_FILENAME, mimeType: 'application/json', parents: [rootId] })],
      { type: 'application/json' }
    ))
    form.append('media', new Blob([JSON.stringify(manifest)], { type: 'application/json' }))
    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,headRevisionId',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const error = new Error(err.error?.message || `Manifest create failed: ${res.status}`)
      error.status = res.status
      throw error
    }
    return res.json()
  })
}

/**
 * Append entries to the manifest with If-Match retry. Caller passes pre-built
 * entries WITHOUT seq — this function assigns seq based on the current head.
 *
 * Compacts opportunistically if length exceeds MAX_ENTRIES.
 */
export async function appendChanges(rootId, entries) {
  if (!entries || entries.length === 0) return
  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    const head = await readManifest(rootId)
    if (!head) {
      throw new Error('Manifest missing — migration must run first')
    }
    const { manifest, fileId, headRevisionId } = head
    const baseSeq = manifest.seq || 0
    const assigned = entries.map((e, i) => ({ ...e, seq: baseSeq + i + 1 }))
    let next = {
      ...manifest,
      seq: baseSeq + entries.length,
      changes: [...manifest.changes, ...assigned],
    }
    if (next.changes.length > MAX_ENTRIES) next = compactManifest(next)
    const res = await writeManifestWithIfMatch(fileId, next, headRevisionId)
    if (res.ok) return next
    // 412 — another device appended between read and write. Re-read and retry.
  }
  // Out of retries. Don't throw — manifest is a hint; the entity file is
  // already written. Next push or compaction sweep will heal the log.
  console.warn('[manifest] append gave up after retries — entity files still authoritative')
}

/**
 * In-place compaction: keep only the most recent entry per {type,id} within
 * a 24h window, plus everything outside the window. Deterministic so two
 * devices racing produce the same result.
 */
export function compactManifest(manifest) {
  const cutoff = new Date(Date.now() - COMPACT_KEEP_HOURS * 3600_000).toISOString()
  const recentByKey = new Map()
  const keep = []
  // Walk newest → oldest. For each {type,id}, keep only the first (newest)
  // occurrence within the recent window. Older-than-cutoff entries are
  // dropped unconditionally (state lives in entity files).
  const sorted = [...manifest.changes].sort((a, b) => (b.seq || 0) - (a.seq || 0))
  for (const c of sorted) {
    if (!c.at || c.at < cutoff) continue
    const key = `${c.type}:${c.id}`
    if (recentByKey.has(key)) continue
    recentByKey.set(key, true)
    keep.push(c)
  }
  keep.sort((a, b) => (a.seq || 0) - (b.seq || 0))
  return {
    ...manifest,
    changes: keep,
    compactedAt: nowIso(),
  }
}

/**
 * Diff a manifest against a localLastSeq. Returns the unique {type,id,op}
 * tuples this device hasn't seen yet. If the gap is larger than the manifest
 * covers (ring wrapped while we were away), returns { gap: true }.
 */
export function diffManifest(manifest, localLastSeq) {
  if (!manifest || !Array.isArray(manifest.changes)) return { changes: [] }
  const minSeq = manifest.changes.length ? (manifest.changes[0].seq || 0) : (manifest.seq || 0)
  // Ring wrapped: we missed entries older than what's still in the log.
  // Caller falls back to cold-start enumeration.
  if (localLastSeq > 0 && minSeq > localLastSeq + 1) {
    return { gap: true, headSeq: manifest.seq || 0 }
  }
  const seen = new Map()
  for (const c of manifest.changes) {
    if ((c.seq || 0) <= localLastSeq) continue
    const key = `${c.type}:${c.id}`
    // Keep the newest op per entity in the unseen window.
    seen.set(key, c)
  }
  return { changes: Array.from(seen.values()), headSeq: manifest.seq || 0 }
}
