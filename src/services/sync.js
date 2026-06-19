/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: merge local + Drive on connect (newer updatedAt wins per id);
 * local writes push to Drive immediately when online.
 */
import {
  putTasks, putNotes, putJournal, getConfig, putConfig,
  putMeta, getAllTasksRaw, getAllNotesRaw, purgeTombstones,
  getDirty, clearDirty, putAudio, getAllAudio,
  getTaskDocBytes, putTaskWithDoc, putTaskDocBytes, getTask,
  getNoteDocBytes, putNoteWithDoc, getNoteRaw,
  getJournalDocBytes, putJournalWithDoc, getAllJournals, getJournal,
  getConfigDocBytes, putConfigWithDoc,
} from './db'
import {
  getDriveFileIds, readJsonFile,
  readEntityFilesBatched, listFolder,
  writeEntityBinFile, readEntityBinFilesBatched, readEntityBinFile,
} from './drive'
import { appendChanges, getDeviceId, readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { migrateDriveEntitiesIfNeeded } from './entitiesMigration'
import { migrateTasksToAutomergeIfNeeded } from './tasksAutomergeMigration'
import { migrateNotesToAutomergeIfNeeded } from './notesAutomergeMigration'
import { migrateJournalsToAutomergeIfNeeded } from './journalsAutomergeMigration'
import { migrateConfigToAutomergeIfNeeded } from './configAutomergeMigration'
import { migrateAudioInlineIfNeeded } from './audioInlineMigration'
import {
  createDoc, loadDoc, saveDoc, mergeDoc, sharesAncestry,
  applyTaskFields, materializeTaskRow, mergeTaskLWW,
  applyNoteFields, materializeNoteRow, mergeNoteLWW,
  materializeJournalRow, reconcileLiveRow,
  applyConfigFields, materializeConfigRow,
} from './automergeDoc'
import { journalApply, journalMerge } from './automergeWorkerClient'
import { dayKey } from '../lib/dates'
import { logSync } from './syncLog'

const LAST_SYNC_KEY = 'last_sync'

/**
 * Resolve two disjoint-root Automerge docs (no shared ancestry, so they can't
 * be CRDT-merged) by recency: return whichever was updated last. Ties go to
 * remote so a stale/empty local doc can never beat fresher remote content —
 * this is the heal path for the cross-device staleness bug. `materialize` is
 * the type's row materializer (used only to read `updatedAt`).
 */
function newerDoc(localDoc, remoteDoc, materialize) {
  const lt = new Date(materialize(localDoc)?.updatedAt || 0).getTime()
  const rt = new Date(materialize(remoteDoc)?.updatedAt || 0).getTime()
  return lt > rt ? localDoc : remoteDoc
}

/**
 * Phase B staged merge. Runs `migrateDriveEntitiesIfNeeded` (idempotent), then
 * resolves bucket promises as each stage completes:
 *
 *   Stage 1: manifest read + config + today's journal (resolves `today`, `config`).
 *   Stage 2: tasks + audio meta (resolves `tasks`, `audio`).
 *   Stage 3: notes (resolves `notes`).
 *
 * Each stage uses manifest-diff if `localLastSeq` covers the gap, else
 * cold-start enumeration via `listFolder` + `readEntityFilesBatched`. Local
 * writes pass `{fromSync: true}` to avoid re-marking dirty.
 *
 * `done` resolves with `{ mergedConfig }` once every stage finishes. Callers
 * can await `done` to start the sync engine afterwards.
 */
export function mergeWithDriveStreaming(onProgress = null) {
  // `today` = today's single journal day (resolved alongside config in Stage 1;
  // the actual today-doc merge is done by loadJournal). `journals` = ALL past /
  // historical journal days (Stage 4) — distinct from `today`. Review, Search,
  // and the sidebar day picker depend on `journals`, not `today`.
  const buckets = { today: null, journals: null, tasks: null, audio: null, notes: null, config: null }
  const resolvers = {}
  for (const k of Object.keys(buckets)) {
    buckets[k] = new Promise(r => { resolvers[k] = r })
    buckets[k].catch(() => {})
  }

  const done = (async () => mergeWithDriveImpl(resolvers, onProgress))()

  return { buckets, done }
}

export async function mergeWithDrive() {
  return mergeWithDriveStreaming().done
}

/**
 * Read the manifest and split changed entities by type. Returns
 * `{ coldStart, headSeq, changedByType: { task, note, audio } }`.
 * On `coldStart`, the caller enumerates the full folder.
 */
async function inspectManifest(rootId) {
  const head = await readManifest(rootId)
  const localLastSeq = await getLocalLastSeq()
  const changedByType = { task: new Map(), note: new Map(), audio: new Map(), journal: new Map(), config: new Map() }
  if (!head) return { coldStart: true, headSeq: 0, changedByType, localLastSeq }
  const headSeq = head.manifest.seq || 0
  const diff = diffManifest(head.manifest, localLastSeq)
  if (diff.gap) return { coldStart: true, headSeq, changedByType, localLastSeq }
  for (const c of diff.changes || []) {
    const bucket = changedByType[c.type]
    if (bucket) bucket.set(c.id, c)
  }
  return { coldStart: false, headSeq, changedByType, localLastSeq }
}

/**
 * Resolve the per-entity docs we need for a bucket: full folder enumeration
 * on cold start, otherwise just the changed ids from the manifest diff.
 */
async function resolveEntityDocs(folderId, coldStart, changedMap, onProgress = null, label = null) {
  if (coldStart) {
    const files = await listFolder(folderId)
    const entries = files
      .map(f => {
        const m = /^(.+)\.json$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
    if (onProgress) onProgress(label, 0, entries.length)
    return readEntityFilesBatched(folderId, entries, 20, (cur, total) => {
      if (onProgress) onProgress(label, cur, total)
    })
  }
  const ids = Array.from(changedMap.keys())
  if (!ids.length) return []
  return readEntityFilesBatched(folderId, ids.map(id => ({ id })))
}

/**
 * Phase C task pull. For each remote-changed id, fetches the `.bin` Automerge
 * doc. The migration deletes `.json` after writing `.bin`, so post-migration
 * `.bin` is the only on-disk format.
 *
 * Returns [{ id, bytes }] where bytes is null on missing (manifest-delete
 * cases — the row is tombstoned in mergeTaskDocs).
 */
export async function resolveTaskDocs(folderId, coldStart, changedMap) {
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    entries = files
      .map(f => {
        const m = /^(.+)\.bin$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, fileId: undefined }))
  }

  if (!entries.length) return []
  return readEntityBinFilesBatched(folderId, entries)
}

/**
 * Resolve the config singleton's Automerge doc. Config has one fixed id
 * ("config"), so this is just: fetch config/config.bin when cold-starting or
 * when the manifest flagged config changed. Returns `{ id, bytes }` or null
 * (no .bin yet / nothing changed).
 */
export async function resolveConfigDoc(folderId, coldStart, changedMap) {
  if (!folderId) return null
  if (!coldStart && !(changedMap && changedMap.size)) return null
  try {
    const bytes = await readEntityBinFile(folderId, 'config')
    return { id: 'config', bytes }
  } catch (e) {
    // Read failure ≠ missing file: carry the error so the floor-hold and the
    // cold-pull completeness check see it (same contract as the batched readers).
    return { id: 'config', bytes: null, err: String(e?.message || e).slice(0, 140) }
  }
}

/**
 * Merge the remote config doc into the local one (singleton). Mirrors
 * mergeTaskDocs for a single id: shared-ancestry → Automerge.merge; disjoint
 * roots → newer-by-updatedAt (ties to remote); no local bytes → adopt remote
 * and re-apply the local row on top. Persists merged row + bytes and returns
 * the materialized config row, or null if there was nothing to merge.
 */
export async function mergeConfigDoc(configDoc) {
  if (!configDoc || !configDoc.bytes) return null
  const remoteDoc = await loadDoc(configDoc.bytes)
  const localBytes = await getConfigDocBytes()
  const localRow = await getConfig()
  let mergedDoc
  if (localBytes) {
    const localDoc = await loadDoc(localBytes)
    if (await sharesAncestry(localDoc, remoteDoc)) {
      mergedDoc = await mergeDoc(localDoc, remoteDoc)
    } else {
      mergedDoc = newerDoc(localDoc, remoteDoc, materializeConfigRow)
    }
  } else if (localRow && Object.keys(localRow).length) {
    mergedDoc = await applyConfigFields(remoteDoc, localRow)
  } else {
    mergedDoc = remoteDoc
  }
  const mergedBytes = await saveDoc(mergedDoc)
  const mergedRow = materializeConfigRow(mergedDoc)
  await putConfigWithDoc(mergedRow, mergedBytes, { fromSync: true })
  return mergedRow
}

/**
 * Find manifest-flagged upserts whose entity fetch came back empty this pass —
 * a Drive read miss or a swallowed fetch failure (the batched readers return
 * `bytes: null` for both; `err` is set on the failure case). The merge helpers
 * skip those ids, so if the caller still advances its seq floor past them the
 * change is marked "seen" and never retried: a permanent silent drop. Both the
 * poll path and the boot merge cap their setLocalLastSeq advance to
 * `minSeq - 1` (the 2026-06-12 22-task staleness came from the boot path
 * missing this guard).
 *
 * `resolved[type]` is the [{ id, bytes }] list that was fetched; pass null for
 * a type whose resolve stage failed outright (treats every upsert in that
 * bucket as unresolved). Deletes never hold the floor — their null bytes are
 * intentional (tombstone written from the manifest entry alone).
 */
export function findUnresolvedUpserts(changedByType, resolved) {
  let minSeq = Infinity
  const unresolved = []
  let errSample = null
  for (const type of Object.keys(resolved)) {
    const docs = resolved[type]
    const byId = docs === null ? null : new Map(docs.map(d => [d.id, d]))
    for (const [id, change] of changedByType[type] || []) {
      if (change.op === 'delete') continue
      const doc = byId === null ? null : byId.get(id)
      if (byId !== null && (doc === undefined || doc.bytes)) continue
      const seq = change.seq || 0
      if (seq > 0 && seq < minSeq) minSeq = seq
      unresolved.push(`${type}:${String(id).slice(0, 8)}@${seq}`)
      if (!errSample && doc?.err) errSample = doc.err
    }
  }
  return { minSeq, unresolved, errSample }
}

/**
 * Cold-start counterpart of findUnresolvedUpserts. A cold pull enumerates the
 * full folder, so there are no manifest seqs to cap the floor to — the only
 * safe floor adoption is all-or-nothing. Every cold-start entry came from a
 * folder listing (fileId known), so `err` unambiguously means "the file is on
 * Drive but its download failed" — a genuinely missing file has no err and is
 * fine to skip. A null bucket means that resolve stage never ran/failed
 * outright. Either kind of failure means adopting headSeq would mark the holes
 * "seen" forever (the silent-drop class); callers must leave the floor
 * untouched so the next pass re-detects the gap and re-runs the pull until one
 * clean pass.
 */
export function findColdPullFailures(resolved) {
  const failures = []
  let errSample = null
  for (const type of Object.keys(resolved)) {
    const docs = resolved[type]
    if (docs === null) {
      failures.push(`${type}:*`)
      continue
    }
    for (const d of docs) {
      if (!d?.err) continue
      failures.push(`${type}:${String(d.id).slice(0, 8)}`)
      if (!errSample) errSample = d.err
    }
  }
  return { failures, errSample }
}

export async function mergeTaskDocs(taskDocs, changedMap) {
  const local = await getAllTasksRaw()
  const localById = new Map(local.map(t => [t.id, t]))
  const writeRows = []
  const writeDocBytes = new Map() // id → bytes
  for (const { id, bytes, err } of taskDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!bytes) {
      // .bin missing. If the manifest says delete, write a tombstone row so
      // the UI hides it locally too.
      if (change?.op === 'delete') {
        writeRows.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      } else {
        // Manifest flagged this id as an upsert, but its .bin fetch came back
        // empty (read miss or swallowed fetch failure — `err` says which). We
        // skip it here; the caller's findUnresolvedUpserts floor-hold keeps
        // the change retryable on the next poll. Probe records every skip so
        // a stale device's flush log shows exactly what failed and why.
        logSync('mergeTaskDocs SKIP upsert with null bytes (silent loss)', {
          id: id.slice(0, 8),
          op: change?.op || null,
          seq: change?.seq ?? null,
          hadLocalRow: !!l,
          err: err || null,
        })
      }
      continue
    }

    const remoteDoc = await loadDoc(bytes)

    // Local doc: load if we have bytes and merge (shared Automerge ancestry).
    // If we have NO local bytes, the remote doc is authoritative — adopt it as
    // the base and re-apply the local row's fields on top. We must NOT
    // createDoc() a fresh-root local doc and Automerge.merge it: two docs with
    // disjoint roots don't union their list content, so the merge silently
    // drops the remote's blocks/fields (the cross-device staleness bug).
    const localBytes = await getTaskDocBytes(id)
    let mergedDoc
    if (localBytes) {
      const localDoc = await loadDoc(localBytes)
      // Heal disjoint-root local docs (see mergeJournalDocs for rationale).
      if (await sharesAncestry(localDoc, remoteDoc)) {
        // Per-field wall-clock LWW, NOT a bare Automerge.merge. A plain merge
        // resolves each concurrent scalar by actor-id (not time), so a newer
        // edit can revert and `updatedAt` runs backwards — the live "edits
        // disappear" bug. mergeTaskLWW merges history then picks each field from
        // the parent with the newer per-field stamp. (proven: scripts/repro-task-lww.mjs)
        mergedDoc = await mergeTaskLWW(localDoc, remoteDoc)
      } else {
        mergedDoc = newerDoc(localDoc, remoteDoc, materializeTaskRow)
      }
    } else if (l) {
      mergedDoc = await applyTaskFields(remoteDoc, l)
    } else {
      mergedDoc = remoteDoc
    }

    // Re-assert the live ROW's authority over the merge. updateTask owns row
    // fields and only marks dirty — it does NOT re-serialize the doc until
    // pushTasks runs, so the ROW can be NEWER than the doc bytes we just merged
    // (offline/paused edits, AND the single-device poll-vs-push race where a
    // force-poll merge lands before push re-serializes). materializing the merge
    // over a newer row would revert the user's edit (status flips back, typed
    // text vanishes, updatedAt backwards). reconcileLiveRow re-folds the row
    // ONLY when it's strictly newer than the merged doc, stamping `_fts` at the
    // row clock so the edit also wins the next cross-device merge and pushTasks
    // ships it. The dirty flag can't gate this (pushTasks clearDirty()s before
    // the racing merge reads it) — recency is the timing-independent authority.
    // (proven: scripts/repro-row-ahead-merge.mjs)
    if (l) {
      const before = mergedDoc
      mergedDoc = await reconcileLiveRow(mergedDoc, l, applyTaskFields, materializeTaskRow)
      if (mergedDoc !== before) {
        logSync('mergeTaskDocs row authority re-fold', {
          id: id.slice(0, 8), status: l.status, rowUpd: l.updatedAt,
        })
      }
    }

    const mergedBytes = await saveDoc(mergedDoc)
    const mergedRow = materializeTaskRow(mergedDoc)
    // Diagnostic: did this poll-merge change what the user has locally? If the
    // merged row's status/title/explanation differs from the local row, this is
    // the moment a synced edit could get reverted. `path` tells us which merge
    // branch produced it (lww = per-field wall-clock; newerDoc = disjoint-root;
    // adoptRemote = no local bytes). `updBackwards` is the proof-of-fix signal:
    // after the LWW change it must NEVER be true on the `lww` path.
    if (l) {
      const changedFields = []
      if ((mergedRow.status || '') !== (l.status || '')) changedFields.push('status')
      if (!!mergedRow.title !== !!l.title) changedFields.push('title')
      if ((mergedRow.explanation || '') !== (l.explanation || '')) changedFields.push('explanation')
      if ((mergedRow.updatedAt || '') !== (l.updatedAt || '')) changedFields.push('updatedAt')
      // Probe: `order` carries task position. The "stale order on the other
      // device" report needs to know whether the merge actually adopted the
      // remote's new order or kept the local one — order isn't checked above.
      if ((mergedRow.order ?? null) !== (l.order ?? null)) changedFields.push('order')
      if (changedFields.length) {
        const path = localBytes ? (await sharesAncestry(await loadDoc(localBytes), remoteDoc) ? 'lww' : 'newerDoc') : (l ? 'adoptRemote' : 'remote')
        const updBackwards = new Date(mergedRow.updatedAt || 0).getTime() < new Date(l.updatedAt || 0).getTime()
        logSync('mergeTaskDocs CHANGED local', {
          id: id.slice(0, 8), path, changedFields, updBackwards,
          localStatus: l.status, mergedStatus: mergedRow.status,
          localUpd: l.updatedAt, mergedUpd: mergedRow.updatedAt,
          localOrder: l.order ?? null, mergedOrder: mergedRow.order ?? null,
        })
      }
    }
    writeRows.push(mergedRow)
    writeDocBytes.set(id, mergedBytes)
    localById.set(id, mergedRow)
  }

  // Persist each merged row + its bytes atomically (one record per row).
  for (const row of writeRows) {
    const bytes = writeDocBytes.get(row.id)
    if (bytes) {
      await putTaskWithDoc(row, bytes, { fromSync: true })
    } else {
      await putTasks([row], { fromSync: true })
    }
  }
  return Array.from(localById.values())
}

/**
 * Phase C note pull. Same shape as resolveTaskDocs: for each remote-changed
 * id (or full folder on cold start), fetch `notes/<id>.bin`.
 *
 * Returns [{ id, bytes }] where bytes is null on missing (manifest-delete
 * cases — handled by mergeNoteDocs as a tombstone).
 */
export async function resolveNoteDocs(folderId, coldStart, changedMap) {
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    entries = files
      .map(f => {
        const m = /^(.+)\.bin$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, fileId: undefined }))
  }

  if (!entries.length) return []
  return readEntityBinFilesBatched(folderId, entries)
}

export async function mergeNoteDocs(noteDocs, changedMap) {
  const local = await getAllNotesRaw()
  const localById = new Map(local.map(n => [n.id, n]))
  const writeRows = []
  const writeDocBytes = new Map()
  for (const { id, bytes } of noteDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!bytes) {
      // .bin missing on remote. If the manifest says delete, write a tombstone
      // row locally so the UI hides the note immediately.
      if (change?.op === 'delete') {
        writeRows.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      }
      continue
    }

    const remoteDoc = await loadDoc(bytes)

    // No local bytes → remote is authoritative: adopt it and re-apply the local
    // row's fields on top. Never createDoc()+merge a disjoint-root local doc —
    // that drops the remote's blocks (see mergeTaskDocs for the full rationale).
    const localBytes = await getNoteDocBytes(id)
    let mergedDoc
    if (localBytes) {
      const localDoc = await loadDoc(localBytes)
      // Heal disjoint-root local docs (see mergeJournalDocs for rationale).
      if (await sharesAncestry(localDoc, remoteDoc)) {
        // Per-field wall-clock LWW for scalar fields (blocks stay on Automerge's
        // id-keyed merge). Same actor-id-not-time fix as tasks — see mergeTaskLWW.
        mergedDoc = await mergeNoteLWW(localDoc, remoteDoc)
      } else {
        mergedDoc = newerDoc(localDoc, remoteDoc, materializeNoteRow)
      }
    } else if (l) {
      mergedDoc = await applyNoteFields(remoteDoc, l)
    } else {
      mergedDoc = remoteDoc
    }

    // Re-assert the live ROW's authority — same row-ahead-of-doc skew as tasks
    // (updateNote writes the row + defers doc serialization to pushNotes), so a
    // poll-merge can land before the edit is in the doc. applyNoteFields re-folds
    // scalars by LWW and reconciles `blocks` id-keyed (append-only, never
    // tombstones a freshly-merged remote block), so the body is body-safe.
    // (proven: scripts/repro-row-ahead-merge.mjs section C)
    if (l) {
      mergedDoc = await reconcileLiveRow(mergedDoc, l, applyNoteFields, materializeNoteRow)
    }

    const mergedBytes = await saveDoc(mergedDoc)
    const mergedRow = materializeNoteRow(mergedDoc)
    writeRows.push(mergedRow)
    writeDocBytes.set(id, mergedBytes)
    localById.set(id, mergedRow)
  }

  for (const row of writeRows) {
    const bytes = writeDocBytes.get(row.id)
    if (bytes) {
      await putNoteWithDoc(row, bytes, { fromSync: true })
    } else {
      await putNotes([row], { fromSync: true })
    }
  }
  return Array.from(localById.values())
}

/**
 * Phase C journal pull. On cold start we enumerate the whole journals/ folder
 * (every day this user has ever recorded) so the local IDB matches Drive.
 * Steady state pulls only the dates the manifest says changed.
 *
 * Journal id is the date string (YYYY-MM-DD).
 */
export async function resolveJournalDocs(folderId, coldStart, changedMap) {
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    entries = files
      .map(f => {
        const m = /^(.+)\.bin$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, fileId: undefined }))
  }

  if (!entries.length) return []
  return readEntityBinFilesBatched(folderId, entries)
}

/**
 * Merge journal `.bin` docs into IDB. Same shape as mergeTaskDocs/mergeNoteDocs.
 * Returns the merged rows (currently unused by callers, but kept for symmetry).
 */
export async function mergeJournalDocs(journalDocs, changedMap) {
  const local = await getAllJournals()
  const localByDate = new Map(local.map(d => [d.date, d]))
  const writeRows = []
  const writeDocBytes = new Map()
  for (const { id, bytes } of journalDocs) {
    const l = localByDate.get(id)
    const change = changedMap?.get?.(id)
    if (!bytes) {
      // A journal "delete" isn't really a user-facing concept today, but if a
      // manifest entry says delete and the .bin is gone, treat it as a soft
      // delete so the local row reflects reality. Currently no UI surfaces it.
      if (change?.op === 'delete' && l) {
        writeRows.push({ ...l, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localByDate.delete(id)
      }
      continue
    }

    // Off-thread the load→merge→save chain. Disjoint-root reconcile (the
    // staleness heal) lives inside journalMerge, unchanged.
    const localBytes = await getJournalDocBytes(id)
    const { bytes: mergedBytes, row: mergedRow } =
      await journalMerge({ remoteBytes: bytes, localBytes, localRow: l })
    if (!mergedRow.date) mergedRow.date = id
    // Probe: did a remote journal .bin actually arrive + change local content?
    // The journal sync path had zero instrumentation, so the "wrote on laptop,
    // didn't appear on phone" reports were un-diagnosable. Log lengths only — no
    // entry text — so the flushed log stays PII-free.
    try {
      const localLen = Array.isArray(l?.blocks) ? l.blocks.filter(b => !b?.deleted).length : 0
      const mergedLen = Array.isArray(mergedRow?.blocks) ? mergedRow.blocks.filter(b => !b?.deleted).length : 0
      logSync('mergeJournalDocs merged', {
        id,
        op: change?.op || null,
        hadLocalBytes: !!localBytes,
        localBlocks: localLen,
        mergedBlocks: mergedLen,
        blocksChanged: mergedLen !== localLen,
        updChanged: (l?.updatedAt || null) !== (mergedRow?.updatedAt || null),
      })
    } catch { /* logging must never break the merge */ }
    writeRows.push(mergedRow)
    writeDocBytes.set(id, mergedBytes)
    localByDate.set(id, mergedRow)
  }

  for (const row of writeRows) {
    const bytes = writeDocBytes.get(row.date)
    if (bytes) {
      await putJournalWithDoc(row, bytes, { fromSync: true })
    } else {
      await putJournal(row, { fromSync: true })
    }
  }
  return Array.from(localByDate.values())
}

async function mergeAudioDocs(audioDocs, changedMap) {
  // We don't return a list to the store — the audio UI hydrates from IDB on
  // demand. Apply writes here so transcripts/tombstones land before Stage 2
  // resolves.
  const localAudio = await getAllAudio()
  const localById = new Map(localAudio.map(a => [a.id, a]))
  for (const { id, doc: entry } of audioDocs) {
    const change = changedMap.get(id)
    if (!entry) {
      if (change?.op === 'delete') {
        const local = localById.get(id)
        if (local && !local.deleted) {
          await putAudio({ ...local, deleted: true, deletedAt: change.at }, { fromSync: true })
        }
      }
      continue
    }
    const local = localById.get(id)
    if (!local) {
      await putAudio({
        id: entry.id,
        blob: null,
        mimeType: entry.mimeType || 'audio/webm',
        duration: entry.duration || 0,
        createdAt: entry.createdAt || new Date().toISOString(),
        driveFileId: entry.driveFileId || null,
        transcript: entry.transcript || null,
        transcriptModel: entry.transcriptModel || null,
        transcribedAt: entry.transcribedAt || null,
        transcriptSegments: entry.transcriptSegments || null,
        deleted: entry.deleted || false,
        deletedAt: entry.deletedAt || null,
        sourceType: entry.sourceType || null,
        sourceId: entry.sourceId || null,
        sourceTitle: entry.sourceTitle || null,
      }, { fromSync: true })
      continue
    }
    const localT = new Date(local.transcribedAt || 0).getTime()
    const remoteT = new Date(entry.transcribedAt || 0).getTime()
    const remoteHasTranscript = !!(entry.transcript || (Array.isArray(entry.transcriptSegments) && entry.transcriptSegments.length))
    const localHasTranscript = !!(local.transcript || (Array.isArray(local.transcriptSegments) && local.transcriptSegments.length))
    const takeRemote = (!!entry.transcribedAt && remoteT >= localT) || (remoteHasTranscript && !localHasTranscript)
    const localDelT = new Date(local.deletedAt || 0).getTime()
    const remoteDelT = new Date(entry.deletedAt || 0).getTime()
    const remoteWinsTrash = remoteDelT > localDelT
    if (!takeRemote && !remoteWinsTrash && local.transcribedAt) continue
    await putAudio({
      ...local,
      driveFileId: local.driveFileId || entry.driveFileId || null,
      transcript: takeRemote ? (entry.transcript || null) : local.transcript,
      transcriptModel: takeRemote ? (entry.transcriptModel || null) : local.transcriptModel,
      transcribedAt: takeRemote ? (entry.transcribedAt || null) : local.transcribedAt,
      transcriptSegments: takeRemote ? (entry.transcriptSegments || null) : local.transcriptSegments,
      deleted: remoteWinsTrash ? (entry.deleted || false) : (local.deleted || false),
      deletedAt: remoteWinsTrash ? (entry.deletedAt || null) : (local.deletedAt || null),
      sourceType: entry.sourceType || local.sourceType || null,
      sourceId: entry.sourceId || local.sourceId || null,
      sourceTitle: entry.sourceTitle || local.sourceTitle || null,
    }, { fromSync: true })
  }
}

async function mergeWithDriveImpl(resolvers, onProgress = null) {
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids) {
    for (const r of Object.values(resolvers)) r(null)
    return {}
  }
  mark('getDriveFileIds', t0)

  // One-time Drive entities migration (idempotent; flag-gated). Must complete
  // before any stage that touches the manifest or per-entity folders. If it
  // fails partway, flag isn't set and we retry next boot — but the legacy
  // bulk files are still around so the user's data is intact.
  try {
    const tMig = performance.now()
    await migrateDriveEntitiesIfNeeded()
    mark('entities migration', tMig)
  } catch (e) {
    console.warn('[sync] entities migration failed:', e.message || e)
  }

  // Phase C tasks migration: converts tasks/<id>.json → tasks/<id>.bin
  // (Automerge binary). Idempotent; flag-gated; runs alongside the dual-write
  // window before any push/pull touches the tasks folder.
  try {
    const tMig = performance.now()
    await migrateTasksToAutomergeIfNeeded()
    mark('automerge tasks migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge tasks migration failed:', e.message || e)
  }

  // Phase C notes migration: notes/<id>.json → notes/<id>.bin (Automerge).
  // Same shape as tasks — idempotent, flag-gated, hard cutover.
  try {
    const tMig = performance.now()
    await migrateNotesToAutomergeIfNeeded()
    mark('automerge notes migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge notes migration failed:', e.message || e)
  }

  // Phase C journals migration: journals/<date>.json → <date>.bin (Automerge).
  // Same shape as tasks/notes — idempotent, flag-gated, hard cutover. Falls in
  // line with the cold-start full-folder pull below so a fresh device picks up
  // every day's journal, not just the day the user happens to open.
  try {
    const tMig = performance.now()
    await migrateJournalsToAutomergeIfNeeded()
    mark('automerge journals migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge journals migration failed:', e.message || e)
  }

  // Config migration: config.json → config/config.bin (Automerge singleton).
  // Idempotent; flag-gated. Needs the manifest (Phase B) to exist so the config
  // change is discoverable by other devices.
  try {
    const tMig = performance.now()
    await migrateConfigToAutomergeIfNeeded()
    mark('automerge config migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge config migration failed:', e.message || e)
  }

  // Inline audio metadata into the doc nodes that reference it (and recover
  // orphaned blobs whose meta was lost). Runs after notes+journals are in .bin
  // form since it rewrites those docs in place. Idempotent + flag-gated.
  try {
    const tMig = performance.now()
    await migrateAudioInlineIfNeeded()
    mark('audio inline migration', tMig)
  } catch (e) {
    console.warn('[sync] audio inline migration failed:', e.message || e)
  }

  // Re-fetch ids after migration in case it rewrote drive_files (legacy ids
  // cleared post-migration).
  const idsAfterMig = await getDriveFileIds()
  const rootId = idsAfterMig.rootId
  const tasksFolderId = idsAfterMig.tasksFolderId
  const notesFolderId = idsAfterMig.notesFolderId
  const audioMetaFolderId = idsAfterMig.audioMetaFolderId
  const journalsFolderId = idsAfterMig.journalsFolderId
  const configFolderId = idsAfterMig.configFolderId

  // Inspect manifest once; reuse across stages.
  const tManifest = performance.now()
  const inspection = await inspectManifest(rootId)
  mark(`manifest inspect (coldStart=${inspection.coldStart})`, tManifest)
  if (inspection.coldStart && onProgress) {
    onProgress({ phase: 'cold-start-begin' })
  }

  // What each stage actually fetched, for the unresolved-upsert floor-hold at
  // the end. null = stage never resolved its docs (treat the whole bucket as
  // unresolved). Audio is intentionally absent — its merge is row-based JSON,
  // not .bin docs, and the poll path's floor-hold ignores it the same way.
  const resolved = { task: null, note: null, journal: null, config: null }

  // -- Stage 1: config + today's journal (cheap, unblocks Today UI) --
  const stage1 = (async () => {
    const tCfg = performance.now()
    // Config is now a per-entity Automerge doc (config/config.bin). Fetch +
    // merge it through the same path as tasks: shared-ancestry merge, else
    // recency heal, else adopt remote. Falls back to the local row if the .bin
    // isn't there yet (pre-migration peer, or write in flight).
    const configDoc = await resolveConfigDoc(configFolderId, inspection.coldStart, inspection.changedByType.config)
    resolved.config = configDoc ? [configDoc] : []
    const mergedConfig = (await mergeConfigDoc(configDoc)) || (await getConfig()) || {}
    mark('config', tCfg)
    resolvers.config(mergedConfig)
    // `today` resolves alongside config — App.jsx's loadJournal() handles the
    // actual journal merge separately. We just signal that Stage 1 is done.
    resolvers.today(mergedConfig)
    return mergedConfig
  })().catch(err => {
    resolvers.config(null); resolvers.today(null); throw err
  })

  // -- Stage 2: tasks + audio meta (parallel) --
  const stage2 = (async () => {
    await stage1.catch(() => {})
    const tStage = performance.now()
    const progress = onProgress
      ? (label, cur, total) => onProgress({ phase: 'cold-start-progress', label, current: cur, total })
      : null
    const [taskDocs, audioDocs] = await Promise.all([
      resolveTaskDocs(tasksFolderId, inspection.coldStart, inspection.changedByType.task),
      resolveEntityDocs(audioMetaFolderId, inspection.coldStart, inspection.changedByType.audio, progress, 'audio'),
    ])
    if (progress && inspection.coldStart) progress('tasks', taskDocs.length, taskDocs.length)
    resolved.task = taskDocs
    const mergedTasks = await mergeTaskDocs(taskDocs, inspection.changedByType.task)
    await mergeAudioDocs(audioDocs, inspection.changedByType.audio)
    mark(`stage2 tasks+audio (cold=${inspection.coldStart}, ${taskDocs.length}t/${audioDocs.length}a)`, tStage)
    resolvers.tasks(mergedTasks.filter(t => !t.deleted))
    resolvers.audio(true)
    return mergedTasks
  })().catch(err => {
    resolvers.tasks(null); resolvers.audio(null); throw err
  })

  // -- Stage 3: notes --
  const stage3 = (async () => {
    await stage2.catch(() => {})
    const tStage = performance.now()
    const noteProgress = onProgress
      ? (cur, total) => onProgress({ phase: 'cold-start-progress', label: 'notes', current: cur, total })
      : null
    const noteDocs = await resolveNoteDocs(notesFolderId, inspection.coldStart, inspection.changedByType.note)
    if (noteProgress && inspection.coldStart) noteProgress(noteDocs.length, noteDocs.length)
    resolved.note = noteDocs
    const mergedNotes = await mergeNoteDocs(noteDocs, inspection.changedByType.note)
    mark(`stage3 notes (cold=${inspection.coldStart}, ${noteDocs.length}n)`, tStage)
    resolvers.notes(mergedNotes.filter(n => !n.deleted))
    return mergedNotes
  })().catch(err => {
    resolvers.notes(null); throw err
  })

  // -- Stage 4: journals --
  // Pulls every journal day on cold start (the missing-old-journals fix) and
  // only the changed dates from the manifest in steady state. Runs in parallel
  // with stage 3; doesn't block any UI-visible bucket (Today's day is already
  // loaded on demand by App.jsx → loadJournal). Once this stage finishes the
  // Sidebar day picker, Search, and tag pool see all historical days.
  const stage4 = (async () => {
    await stage2.catch(() => {})
    const tStage = performance.now()
    const journalProgress = onProgress
      ? (cur, total) => onProgress({ phase: 'cold-start-progress', label: 'journals', current: cur, total })
      : null
    const journalDocs = await resolveJournalDocs(journalsFolderId, inspection.coldStart, inspection.changedByType.journal)
    if (journalProgress && inspection.coldStart) journalProgress(journalDocs.length, journalDocs.length)
    resolved.journal = journalDocs
    await mergeJournalDocs(journalDocs, inspection.changedByType.journal)
    mark(`stage4 journals (cold=${inspection.coldStart}, ${journalDocs.length}j)`, tStage)
    resolvers.journals(journalDocs.length)
    return journalDocs.length
  })().catch(err => {
    console.warn('[sync] stage4 journals failed:', err?.message || err)
    resolvers.journals(null)
  })

  const [mergedConfig] = await Promise.all([stage1, stage2, stage3, stage4])

  // Advance localLastSeq once everything has been applied. Same
  // unresolved-upsert guard as pollOnce: an upsert whose fetch failed above
  // was skipped by the merge helpers, and advancing past it would mark it
  // "seen" forever — the boot-path silent drop that left a device 22 tasks
  // stale on 2026-06-12 after one fetch batch failed. Diff path: hold the
  // floor just below the lowest unresolved seq; the engine's first poll is
  // always forced, re-diffs from there, and refetches. Cold path: no seqs to
  // hold to, so adopting the head is all-or-nothing — any download failure
  // means we keep the old floor, the engine's poll re-detects the gap, and
  // the cold pull re-runs (with the engine's backoff) until one clean pass.
  let advanceTo = inspection.headSeq
  let coldIncomplete = false
  if (inspection.coldStart) {
    const { failures, errSample } = findColdPullFailures(resolved)
    if (failures.length) {
      coldIncomplete = true
      advanceTo = inspection.localLastSeq
      logSync('cold pull INCOMPLETE — head NOT adopted', {
        headSeq: inspection.headSeq,
        failureCount: failures.length,
        failures: failures.slice(0, 30),
        errSample,
      })
    }
  } else {
    const { minSeq, unresolved, errSample } = findUnresolvedUpserts(inspection.changedByType, resolved)
    if (minSeq !== Infinity) {
      advanceTo = Math.min(advanceTo, minSeq - 1)
      logSync('boot seq advance HELD BACK (unresolved upsert)', {
        headSeq: inspection.headSeq, advanceTo, unresolved, errSample,
      })
    }
  }
  if (advanceTo > inspection.localLastSeq) {
    await setLocalLastSeq(advanceTo).catch(() => {})
  }

  if (inspection.coldStart && onProgress) {
    // `incomplete` keeps the boot overlay up (in "retrying" mode) instead of
    // unlocking the app over data with holes; the sync engine clears it after
    // its first clean cold pull.
    onProgress({ phase: 'cold-start-done', incomplete: coldIncomplete })
  }

  putMeta(LAST_SYNC_KEY, Date.now()).catch(() => {})
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  purgeTombstones(cutoff).catch(() => {})

  mark('TOTAL mergeWithDrive', t0)
  return { mergedConfig }
}

/**
 * Pull a fresh copy from Drive (used for subsequent syncs, not first connect).
 * Does NOT merge — assumes Drive is authoritative after initial merge.
 */
export async function pullFromDrive() {
  const ids = await getDriveFileIds()
  if (!ids) return

  const [tasks, notes, config] = await Promise.all([
    readJsonFile(ids.tasksFileId),
    readJsonFile(ids.notesFileId),
    readJsonFile(ids.configFileId),
  ])

  await Promise.all([
    putTasks(Array.isArray(tasks) ? tasks : []),
    putNotes(Array.isArray(notes) ? notes : []),
    putConfig(config || {}),
  ])

  await putMeta(LAST_SYNC_KEY, Date.now())
}

/**
 * Push all dirty tasks to Drive (Phase C — Automerge). Drains the dirty set,
 * merges each task's remote .bin into the local Automerge doc, applies the
 * row's fields, uploads `tasks/<id>.bin`, and appends a single batched
 * manifest entry.
 *
 * Push is read-MERGE-write. "Fold in on the next pull" doesn't hold: the
 * upload replaces the only shared copy, and the device whose changes it
 * overwrites already cleared its dirty token on its own successful push — it
 * never re-pushes, so a blind upload erases its changes from Drive for good
 * (proven on journals 2026-06-11; same hole here).
 *
 * Caller is expected to be wrapped in `withRetry` from syncEngine — failures
 * leave the dirty set intact so the next attempt retries the same ids.
 */
export async function pushTasks() {
  const ids = await getDriveFileIds()
  if (!ids?.tasksFolderId) return null
  const dirty = await getDirty('task')
  const dirtyIds = Object.keys(dirty)
  // PROBE: surface that pushTasks actually ran and how many dirty ids it saw.
  // The "tasks stranded" phone log had ZERO task-push lines — this proves
  // whether pushTasks is even reached (vs coalesced/throwing before this).
  logSync('pushTasks enter', { dirty: dirtyIds.length, ids: dirtyIds.map(i => i.slice(0, 8)) })
  if (dirtyIds.length === 0) return null

  const localTasks = await getAllTasksRaw()
  const localById = new Map(localTasks.map(t => [t.id, t]))
  const deviceId = await getDeviceId()
  const changes = []
  // { id: token } of what we actually shipped, for the compare-and-clear below.
  // Capturing the token BEFORE re-reading the row is what closes the lost-update:
  // an edit that lands after this and bumps the token won't be cleared.
  const pushedTokens = {}

  for (const id of dirtyIds) {
    const token = dirty[id]
    const local = localById.get(id)
    if (!local) {
      // Local row gone but still dirty — nothing to push and no doc to ship.
      // Mark resolved so we don't retry forever; the delete tombstone (if
      // any) already went through a normal local edit and was pushed earlier.
      pushedTokens[id] = token
      continue
    }

    // Re-read the row fresh right before building the doc. The snapshot from the
    // top of pushTasks (getAllTasksRaw) can be stale: this push is fire-and-forget
    // from updateTask, so a SECOND edit to the same task (e.g. mark-done then type
    // feedback) can land after the snapshot. We must ship the latest fields.
    const fresh = (await getTask(id)) || local

    // Pick the base doc: our own bytes merged with the remote .bin, else adopt
    // the remote's root, else (first writer) createDoc. Forking a fresh root
    // when a remote already exists breaks Automerge.merge across devices (the
    // staleness bug).
    const existingBytes = await getTaskDocBytes(id)
    const remoteBytes = await readEntityBinFile(ids.tasksFolderId, id).catch(() => null)
    let doc
    if (existingBytes) {
      doc = await loadDoc(existingBytes)
      if (remoteBytes) {
        const remoteDoc = await loadDoc(remoteBytes)
        // Same per-field wall-clock LWW as the pull side (mergeTaskDocs) — a
        // bare Automerge.merge resolves concurrent scalars by actor-id, not
        // time. Disjoint roots reconcile by recency, also as on pull.
        doc = (await sharesAncestry(doc, remoteDoc))
          ? await mergeTaskLWW(doc, remoteDoc)
          : newerDoc(doc, remoteDoc, materializeTaskRow)
      }
    } else {
      doc = remoteBytes ? await loadDoc(remoteBytes) : await createDoc('task', fresh)
    }
    doc = await applyTaskFields(doc, fresh)
    const bytes = await saveDoc(doc)

    // Persist ONLY the Automerge bytes, never the row. The row is owned by
    // updateTask (the UI write path); pushTasks writing a materialized row here
    // is what clobbered a concurrent edit. putTaskDocBytes is atomic and touches
    // only `_doc`, so a fresh updateTask field set is never lost. This is the
    // canonical ownership split: updateTask owns row fields, push owns doc bytes.
    await putTaskDocBytes(id, bytes)

    await writeEntityBinFile(ids.tasksFolderId, id, bytes)

    changes.push({
      type: 'task',
      id,
      op: fresh.deleted ? 'delete' : 'upsert',
      at: new Date().toISOString(),
      deviceId,
    })
    pushedTokens[id] = token
  }

  // Append to the manifest FIRST, then clear dirty. The manifest entry is what
  // makes the .bin discoverable to other devices' (seq-driven) incremental
  // polls; clearing before it is durably published strands an orphaned .bin if
  // the append fails (the 700-פזו bug). If appendChanges throws — persistent
  // If-Match contention or a network drop — the dirty set stays intact and the
  // retry loop (flushPendingSync → executePush) re-ships + re-appends until it
  // lands. A redundant .bin re-upload / duplicate manifest entry on retry is
  // harmless (idempotent bytes; poll dedups by id, compaction keeps newest).
  if (changes.length) await appendChanges(ids.rootId, changes)
  // Compare-and-clear by token: an edit that re-dirtied an id AFTER we captured
  // its token (the mark-done-then-feedback race) keeps a newer token and is
  // left dirty for the coalesced follow-up push — so its fields aren't dropped.
  await clearDirty('task', pushedTokens)
  logSync('pushTasks done', { shipped: changes.length, cleared: Object.keys(pushedTokens).length })
  return Object.keys(pushedTokens).length
}

/**
 * Push all dirty notes to Drive (Phase C — Automerge). Mirrors pushTasks:
 * merge the remote .bin into the local Automerge doc, apply the row's fields,
 * upload `notes/<id>.bin`. Read-merge-write — see pushTasks for why a blind
 * upload loses other devices' not-yet-pulled edits permanently.
 */
export async function pushNotes() {
  const ids = await getDriveFileIds()
  if (!ids?.notesFolderId) return null
  const dirty = await getDirty('note')
  const dirtyIds = Object.keys(dirty)
  if (dirtyIds.length === 0) return null

  const localNotes = await getAllNotesRaw()
  const localById = new Map(localNotes.map(n => [n.id, n]))
  const deviceId = await getDeviceId()
  const changes = []
  // { id: token } shipped — see pushTasks for the mid-push re-dirty rationale.
  const pushedTokens = {}

  for (const id of dirtyIds) {
    const token = dirty[id]
    const local = localById.get(id)
    if (!local) {
      // Local row gone but still dirty — drop from dirty set; the soft-delete
      // tombstone (if any) was pushed in an earlier iteration.
      pushedTokens[id] = token
      continue
    }

    // Re-read fresh right before serializing: the top-of-function snapshot can
    // be stale if a second edit to the same note landed after it (same
    // fire-and-forget race as pushTasks). Ship the latest fields.
    const fresh = (await getNoteRaw(id)) || local

    // Base doc: own bytes merged with the remote .bin, else adopt the remote
    // root, else createDoc. (Same merge + disjoint-root rules as pushTasks.)
    const existingBytes = await getNoteDocBytes(id)
    const remoteBytes = await readEntityBinFile(ids.notesFolderId, id).catch(() => null)
    let doc
    if (existingBytes) {
      doc = await loadDoc(existingBytes)
      if (remoteBytes) {
        const remoteDoc = await loadDoc(remoteBytes)
        doc = (await sharesAncestry(doc, remoteDoc))
          ? await mergeNoteLWW(doc, remoteDoc)
          : newerDoc(doc, remoteDoc, materializeNoteRow)
      }
    } else {
      doc = remoteBytes ? await loadDoc(remoteBytes) : await createDoc('note', fresh)
    }
    doc = await applyNoteFields(doc, fresh)
    const bytes = await saveDoc(doc)

    // Persist bytes locally before upload so a mid-push crash can't leave the
    // remote ahead of the local doc.
    await putNoteWithDoc(fresh, bytes, { fromSync: true })

    await writeEntityBinFile(ids.notesFolderId, id, bytes)

    changes.push({
      type: 'note',
      id,
      op: fresh.deleted ? 'delete' : 'upsert',
      at: new Date().toISOString(),
      deviceId,
    })
    pushedTokens[id] = token
  }

  // Append first, then clear — see pushTasks: clearing before the manifest is
  // durably published strands an orphaned .bin when the append fails. A throw
  // leaves dirty intact for the retry loop.
  if (changes.length) await appendChanges(ids.rootId, changes)
  // Compare-and-clear by token (see pushTasks): a note re-edited mid-push keeps
  // its newer token and is re-shipped by the coalesced follow-up push.
  await clearDirty('note', pushedTokens)
  return Object.keys(pushedTokens).length
}

/**
 * Push config to Drive (Automerge singleton). Mirrors pushTasks for the single
 * "config" id: drain the dirty flag, merge the remote .bin into our own bytes
 * (→ else adopt the remote root → else createDoc), apply the row's fields,
 * upload config/config.bin, append a manifest entry. Read-merge-write — see
 * pushTasks for why a blind upload loses other devices' not-yet-pulled edits.
 * Plain mergeDoc, matching the config pull side (config isn't per-field LWW'd).
 *
 * Caller is expected to be wrapped in `withRetry` from syncEngine.
 */
export async function pushConfig() {
  const ids = await getDriveFileIds()
  if (!ids?.configFolderId) return null
  const dirty = await getDirty('config')
  if (!dirty.config) return null
  const token = dirty.config

  const local = await getConfig()
  const existingBytes = await getConfigDocBytes()
  const remoteBytes = await readEntityBinFile(ids.configFolderId, 'config').catch(() => null)
  let doc
  if (existingBytes) {
    doc = await loadDoc(existingBytes)
    if (remoteBytes) {
      const remoteDoc = await loadDoc(remoteBytes)
      doc = (await sharesAncestry(doc, remoteDoc))
        ? await mergeDoc(doc, remoteDoc)
        : newerDoc(doc, remoteDoc, materializeConfigRow)
    }
  } else {
    doc = remoteBytes ? await loadDoc(remoteBytes) : await createDoc('config', local || {})
  }
  doc = await applyConfigFields(doc, local || {})
  const bytes = await saveDoc(doc)

  // Persist bytes locally before upload so a mid-push crash can't leave the
  // remote ahead of the local doc.
  await putConfigWithDoc(local || {}, bytes, { fromSync: true })

  await writeEntityBinFile(ids.configFolderId, 'config', bytes)

  // Append first, then clear — see pushTasks: clearing before the manifest is
  // durably published strands the orphaned .bin if the append fails. A throw
  // leaves dirty set for the retry loop.
  await appendChanges(ids.rootId, [{
    type: 'config', id: 'config', op: 'upsert',
    at: new Date().toISOString(), deviceId: await getDeviceId(),
  }])
  // Token-gated: a setting changed mid-push keeps a newer token and re-ships.
  await clearDirty('config', { config: token })
  return 1
}

/**
 * Push a per-day journal doc to Drive (Phase C — Automerge). Mirrors
 * pushTasks/pushNotes: load the local Automerge doc, MERGE the remote .bin into
 * it, apply the row's fields, upload `journals/<date>.bin`, append a manifest
 * entry. Push is read-merge-write: the upload replaces the only shared copy, so
 * it must contain the remote's changes too — "fold in on the next pull" doesn't
 * work for a device whose push already succeeded and cleared its dirty token
 * (it never re-pushes, so a blind upload erases its changes from Drive).
 */
export async function pushJournal(dayDoc) {
  if (!dayDoc?.date) {
    console.warn('pushJournal: skipped — dayDoc has no date', dayDoc)
    return null
  }
  const ids = await getDriveFileIds()
  if (!ids?.journalsFolderId) {
    // Drive folder not initialized yet (e.g. called before initDriveStructure
    // during cold-start). Caller must treat null as "skipped, keep local doc".
    return null
  }
  const date = dayKey(dayDoc.date)
  const source = { ...dayDoc, date }

  // Capture the dirty token for this date NOW, before any await. The clear at
  // the end is gated on it: a journal edit that re-dirties this date mid-push
  // bumps the token, so its clear is skipped and the next push re-ships it
  // (same lost-update fix as pushTasks).
  const dirtyToken = (await getDirty('journal'))[date]

  // Guard: never push a brand-new, never-edited EMPTY day. Opening "today" on a
  // device calls this (loadJournal → mergeAndPushJournal) even when the user has
  // typed nothing. Uploading an empty fresh-root .bin in that moment is the root
  // of the "new mobile entry shows blank on laptop" bug: if the laptop opens the
  // day before the mobile's content has propagated, it mints a disjoint empty
  // root and uploads it; the mobile's real content can then never merge cleanly.
  // Instead, when there are no local bytes and the day is empty, pull-only:
  // adopt the remote .bin if one exists (so the laptop shows what mobile wrote),
  // else do nothing (no upload, nothing to poison).
  const hasLocalBytes = await getJournalDocBytes(date)
  const liveBlocks = Array.isArray(source.blocks) ? source.blocks.filter(b => !b?.deleted).length : 0
  const isEmptyDay = liveBlocks === 0 && !source.reviewedAt
  if (!hasLocalBytes && isEmptyDay) {
    const remoteBytes = await readEntityBinFile(ids.journalsFolderId, date).catch(() => null)
    if (!remoteBytes) return null
    const remoteDoc = await loadDoc(remoteBytes)
    const remoteRow = materializeJournalRow(remoteDoc)
    if (!remoteRow.date) remoteRow.date = date
    await putJournalWithDoc(remoteRow, remoteBytes, { fromSync: true })
    return remoteRow
  }

  // Pick the base doc we apply local fields onto. Priority:
  //   1. our own persisted bytes MERGED with the remote .bin (normal case —
  //      push is read-merge-write so the upload never erases another device's
  //      not-yet-pulled changes from the shared file)
  //   2. the remote .bin if one exists (adopt its root so our upload shares
  //      ancestry with every other device — never fork a disjoint root)
  //   3. only if neither exists are we the first writer → createDoc
  // Minting a fresh-root doc when a remote already exists is what caused the
  // cross-device "0 merged blocks" staleness bug: a disjoint-root doc can't be
  // Automerge.merge'd with the others, so each pull silently drops content.
  // Gather byte inputs on the main thread (IDB + network — non-blocking I/O),
  // then hand the synchronous Automerge load→merge→apply→save chain to the
  // worker so it never freezes the editor. The merge + disjoint-root reconcile
  // both live inside journalApply, shared by worker and inline fallback.
  const existingBytes = await getJournalDocBytes(date)
  const remoteBytes = await readEntityBinFile(ids.journalsFolderId, date).catch(() => null)
  const { bytes, row: merged } = await journalApply({ existingBytes, remoteBytes, source })
  if (!merged.date) merged.date = date

  // Persist locally before upload so a mid-push crash can't leave the remote
  // ahead of the local doc.
  await putJournalWithDoc(merged, bytes, { fromSync: true })

  await writeEntityBinFile(ids.journalsFolderId, date, bytes)

  const deviceId = await getDeviceId()
  // No .catch here: a swallowed append failure clears the dirty flag below
  // while the manifest still doesn't point at the freshly uploaded .bin, which
  // strands it (the 700-פזו bug, same class). Let it throw so the dirty flag
  // survives and the retry loop re-ships + re-appends.
  await appendChanges(ids.rootId, [{
    type: 'journal',
    id: date,
    op: 'upsert',
    at: new Date().toISOString(),
    deviceId,
  }])

  // Resolved successfully — drop from the per-day dirty set (the markDirty
  // call inside putJournal on the user-edit path adds an entry here).
  // Token-gated: if the day was re-edited mid-push it carries a newer token and
  // stays dirty for the next push. If it wasn't dirty at entry (loadJournal
  // pull-push), dirtyToken is undefined and the compare-and-clear only removes
  // the date when it's STILL absent — so a concurrent edit is never wiped.
  await clearDirty('journal', { [date]: dirtyToken }).catch(() => {})
  return merged
}

/**
 * Back-compat: callers used to distinguish "merge then push" from "push". With
 * Automerge that distinction collapses — pushJournal *is* the merge-and-push.
 */
export const mergeAndPushJournal = pushJournal

/**
 * Flush every entity type whose persisted dirty set is non-empty. This is the
 * durable recovery path: dirty tokens live in IDB, so they survive the page
 * reloads and tab kills that destroy an in-flight (or parked) push closure.
 * Tasks/notes/config push by draining their own dirty sets; journals are
 * per-day, so we iterate the journal dirty set and push each day's current
 * local doc. Audio is covered by pushPendingAudio at the call sites (it lives
 * in audio.js).
 *
 * Every bucket is attempted even when an earlier one fails, but a failure is
 * RETHROWN at the end: callers run this through the engine's executePush,
 * whose retry loop is what keeps the work alive until it lands. Swallowing
 * here would report success on a failed flush and strand the dirty set until
 * the next reconnect/boot.
 */
export async function flushPendingSync() {
  const failures = []
  await pushTasks().catch(e => failures.push(['tasks', e]))
  await pushNotes().catch(e => failures.push(['notes', e]))
  await pushConfig().catch(e => failures.push(['config', e]))

  try {
    const dirty = await getDirty('journal')
    const dates = Object.keys(dirty || {})
    for (const date of dates) {
      const doc = await getJournal(date)
      if (doc) await pushJournal(doc).catch(e => failures.push([`journal ${date}`, e]))
    }
  } catch (e) {
    failures.push(['journal drain', e])
  }

  if (failures.length) {
    for (const [bucket, e] of failures) console.warn('flushPendingSync:', bucket, e?.message || e)
    // PROBE: per-bucket flush failures aren't visible on phone (console only).
    // Surface them so a stranded task whose push THREW is distinguishable from
    // one that was never pushed (coalescer-dropped).
    logSync('flushPendingSync FAILED', { buckets: failures.map(([b, e]) => `${b}:${e?.message || e}`).join(' | ') })
    throw failures[0][1]
  }
}
flushPendingSync.label = 'flushPendingSync'

/**
 * True when any persisted dirty token exists — i.e. flushPendingSync has work.
 * Lets reconnect/focus handlers skip the push machinery (and its status
 * flicker) when nothing is pending.
 */
export async function hasPendingSync() {
  for (const type of ['task', 'note', 'config', 'journal']) {
    const dirty = await getDirty(type)
    if (Object.keys(dirty || {}).length > 0) return true
  }
  return false
}

/**
 * Initial sync on connect: merge local data with Drive, then push merged result.
 */
export async function initialSync() {
  return mergeWithDrive()
}

/**
 * Streaming initial sync.
 */
export function initialSyncStreaming() {
  return mergeWithDriveStreaming()
}
