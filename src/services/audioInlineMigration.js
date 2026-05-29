/**
 * One-time migration: inline audio metadata into the document nodes that
 * reference it.
 *
 * Background: audio used to be addressed by `<div data-audio-id="...">` in
 * journal/note docs, with the real metadata (driveFileId, transcript, segments,
 * …) held in a separate `audio/meta/<id>.json`. That two-object split meant a
 * synced doc could reference audio whose meta never arrived — and a lost meta
 * file took the transcript with it. We now carry all of it on the node itself
 * (see AudioNode.jsx); the blob stays in `audio/<id>.<ext>` (binary can't live
 * in the CRDT).
 *
 * This migration walks every journal + note `.bin` doc and, for each audio node
 * still missing `data-drive-file-id`, injects:
 *   - from `audio/meta/<id>.json` when it exists (driveFileId + transcript), or
 *   - just the driveFileId recovered from the surviving `audio/<id>.<ext>` blob
 *     when the meta is gone (transcript unrecoverable, but playback restored).
 *
 * Gating: meta.audio_inline_v1. Idempotent — nodes that already carry a
 * driveFileId are skipped, so re-runs and partial runs are safe. Non-destructive
 * to Drive: leaves audio/meta/*.json and the blobs in place.
 */
import {
  getDriveFileIds, listFolder, readEntityFile,
  readEntityBinFile, writeEntityBinFile,
} from './drive'
import { getMeta, putMeta } from './db'
import { loadDoc, saveDoc, changeDoc } from './automergeDoc'
import { appendChanges, getDeviceId } from './manifest'

const MIGRATION_FLAG = 'audio_inline_v1'
const AUDIO_EXT_RE = /^(.+)\.(webm|ogg|mp3|m4a|mp4|wav|aac)$/i
const EXT_TO_MIME = {
  webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
}

function nowIso() { return new Date().toISOString() }

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Index audio/ blobs by id (filename is `<id>.<ext>`) → { fileId, ext }.
async function indexAudioBlobs(audioFolderId) {
  const out = new Map()
  if (!audioFolderId) return out
  const files = await listFolder(audioFolderId)
  for (const f of files) {
    const m = AUDIO_EXT_RE.exec(f.name || '')
    if (!m) continue
    if (m[1].startsWith('_')) continue
    out.set(m[1], { fileId: f.id, ext: m[2].toLowerCase() })
  }
  return out
}

// List ids that have a per-id meta file in audio/meta/.
async function indexAudioMetaIds(audioMetaFolderId) {
  const out = new Set()
  if (!audioMetaFolderId) return out
  const files = await listFolder(audioMetaFolderId)
  for (const f of files) {
    const m = /^(.+)\.json$/.exec(f.name || '')
    if (m && !m[1].startsWith('_')) out.add(m[1])
  }
  return out
}

// Build the data-* attribute string to inject for one audio id. Pulls from the
// meta file if present, else recovers just the driveFileId from the blob index.
async function buildInjectedAttrs(id, ctx) {
  let driveFileId = null
  let mimeType = null
  let transcript = null
  let transcriptModel = null
  let transcribedAt = null
  let transcriptSegments = null
  let createdAt = null

  if (ctx.metaIds.has(id)) {
    const meta = await readEntityFile(ctx.ids.audioMetaFolderId, id).catch(() => null)
    if (meta) {
      driveFileId = meta.driveFileId || null
      mimeType = meta.mimeType || null
      transcript = meta.transcript || null
      transcriptModel = meta.transcriptModel || null
      transcribedAt = meta.transcribedAt || null
      transcriptSegments = Array.isArray(meta.transcriptSegments) ? meta.transcriptSegments : null
      createdAt = meta.createdAt || null
    }
  }

  // No driveFileId from meta — fall back to the surviving blob.
  if (!driveFileId) {
    const blob = ctx.blobsById.get(id)
    if (blob) {
      driveFileId = blob.fileId
      mimeType = mimeType || EXT_TO_MIME[blob.ext] || 'audio/webm'
    }
  }

  if (!driveFileId) return null // nothing to recover

  let attrs = ` data-drive-file-id="${escAttr(driveFileId)}"`
  if (mimeType) attrs += ` data-mime-type="${escAttr(mimeType)}"`
  if (createdAt) attrs += ` data-created-at="${escAttr(createdAt)}"`
  if (transcript) attrs += ` data-transcript="${escAttr(transcript)}"`
  if (transcriptModel) attrs += ` data-transcript-model="${escAttr(transcriptModel)}"`
  if (transcribedAt) attrs += ` data-transcribed-at="${escAttr(transcribedAt)}"`
  if (transcriptSegments && transcriptSegments.length) {
    attrs += ` data-transcript-segments="${escAttr(JSON.stringify(transcriptSegments))}"`
  }
  return attrs
}

// Returns the rewritten html (or null if unchanged). For each <div data-audio-id>
// that lacks data-drive-file-id, splice in the recovered attrs right after the
// data-audio-id attribute.
async function rewriteBlockHtml(html, ctx) {
  if (!html || html.indexOf('data-audio-id') === -1) return null
  const divRe = /<div\b([^>]*?)data-audio-id="([^"]+)"([^>]*?)>/g
  let changed = false
  const promises = []
  // Collect matches first (regex + async).
  const matches = []
  let m
  while ((m = divRe.exec(html)) !== null) {
    matches.push({ full: m[0], pre: m[1], id: m[2], post: m[3], index: m.index })
  }
  if (!matches.length) return null

  // Resolve injected attrs per unique id.
  const injectById = new Map()
  for (const mm of matches) {
    if (/data-drive-file-id=/.test(mm.full)) continue // already inlined
    if (injectById.has(mm.id)) continue
    promises.push((async () => {
      const attrs = await buildInjectedAttrs(mm.id, ctx)
      injectById.set(mm.id, attrs)
    })())
  }
  await Promise.all(promises)

  // Rebuild html by replacing each match that has injectable attrs.
  let out = ''
  let cursor = 0
  for (const mm of matches) {
    out += html.slice(cursor, mm.index)
    if (/data-drive-file-id=/.test(mm.full)) {
      out += mm.full
    } else {
      const attrs = injectById.get(mm.id)
      if (attrs) {
        out += `<div${mm.pre}data-audio-id="${mm.id}"${attrs}${mm.post}>`
        changed = true
      } else {
        out += mm.full
      }
    }
    cursor = mm.index + mm.full.length
  }
  out += html.slice(cursor)
  return changed ? out : null
}

// Process one folder of .bin docs (journals or notes). Mutates docs in place,
// re-saves, and appends manifest entries. Returns counts.
async function processFolder(folderId, type, ctx) {
  const files = await listFolder(folderId)
  const binIds = files
    .map(f => /^(.+)\.bin$/.exec(f.name || '')?.[1])
    .filter(id => id && !id.startsWith('_'))

  let docsChanged = 0
  let nodesFixed = 0
  const manifestEntries = []
  const deviceId = await getDeviceId()

  const batchSize = 5
  for (let i = 0; i < binIds.length; i += batchSize) {
    const slice = binIds.slice(i, i + batchSize)
    await Promise.all(slice.map(async (id) => {
      let bytes
      try {
        bytes = await readEntityBinFile(folderId, id)
      } catch { return }
      if (!bytes) return
      let doc
      try { doc = await loadDoc(bytes) } catch { return }
      if (!Array.isArray(doc.blocks) || !doc.blocks.length) return

      // Compute rewrites outside the change() (async work isn't allowed inside).
      const rewrites = []
      for (let bi = 0; bi < doc.blocks.length; bi++) {
        const b = doc.blocks[bi]
        const html = b?.html
        if (!html || html.indexOf('data-audio-id') === -1) continue
        const next = await rewriteBlockHtml(html, ctx)
        if (next != null) {
          rewrites.push({ bi, html: next })
          nodesFixed += (next.match(/data-drive-file-id=/g) || []).length
        }
      }
      if (!rewrites.length) return

      const newDoc = await changeDoc(doc, (d) => {
        for (const r of rewrites) {
          if (d.blocks[r.bi]) d.blocks[r.bi].html = r.html
        }
      })
      const newBytes = await saveDoc(newDoc)
      await writeEntityBinFile(folderId, id, newBytes)
      docsChanged++
      manifestEntries.push({ type, id, op: 'upsert', at: nowIso(), deviceId })
    }))
  }

  if (manifestEntries.length) {
    try {
      await appendChanges(ctx.ids.rootId, manifestEntries)
    } catch (e) {
      console.warn('[audio-inline-migration] manifest append failed:', e.message || e)
    }
  }
  return { docsChanged, nodesFixed }
}

export async function migrateAudioInlineIfNeeded() {
  const already = await getMeta(MIGRATION_FLAG)
  if (already) return { skipped: true }

  const ids = await getDriveFileIds()
  if (!ids?.rootId || !ids.journalsFolderId || !ids.notesFolderId) {
    return { skipped: true, reason: 'folders not provisioned' }
  }

  const t0 = performance.now()
  const log = (...args) => console.log('[audio-inline-migration]', ...args)

  const [blobsById, metaIds] = await Promise.all([
    indexAudioBlobs(ids.audioFolderId),
    indexAudioMetaIds(ids.audioMetaFolderId),
  ])
  log(`audio blobs: ${blobsById.size}, meta files: ${metaIds.size}`)

  const ctx = { ids, blobsById, metaIds }

  let journals, notes
  try {
    journals = await processFolder(ids.journalsFolderId, 'journal', ctx)
    notes = await processFolder(ids.notesFolderId, 'note', ctx)
  } catch (e) {
    log('failed; flag NOT set, will retry next boot:', e.message || e)
    return { ok: false, error: e.message || String(e) }
  }

  await putMeta(MIGRATION_FLAG, {
    completedAt: nowIso(),
    journals,
    notes,
  })
  log(`done in ${(performance.now() - t0).toFixed(0)}ms`, { journals, notes })
  return { ok: true, journals, notes }
}
