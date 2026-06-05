/**
 * Sync engine: handles auto-reconnect, retry on failure, and periodic
 * polling so changes on one device appear on another within ~2 seconds.
 *
 * Status shapes:
 *   { state: 'synced' }
 *   { state: 'syncing' }
 *   { state: 'offline' }
 *   { state: 'waiting', retryIn: <seconds remaining> }
 */
import {
  getDriveFileIds, findFile,
  listFolder, readEntityFilesBatched,
} from './drive'
import {
  getAllAudio, putAudio,
} from './db'
import { getStoredToken, trySilentRefresh, storeToken, setAccessToken, isAuthError, withAuthRetry } from './auth'
import {
  resolveTaskDocs, mergeTaskDocs,
  resolveNoteDocs, mergeNoteDocs,
  resolveJournalDocs, mergeJournalDocs,
  resolveConfigDoc, mergeConfigDoc,
} from './sync'
import { readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { blocksToHtml } from '../lib/blocks'
import { logSync } from './syncLog'

const DEFAULT_POLL_INTERVAL = 1000  // 1 second default
const RETRY_BASE_MS = 2000         // retry backoff starts at 2s
const RETRY_MAX_MS = 30000         // max retry backoff 30s

let pollIntervalMs = DEFAULT_POLL_INTERVAL

let pollTimer = null
let retryTimer = null
let countdownTimer = null
let retryCount = 0
let retryStartTime = 0
let listeners = new Set()
let status = { state: 'synced' }
let running = false
let pendingPush = null
let lastRemoteHash = null
let _storeSetter = null
let _storeGetter = null
// Generation counter: bumped whenever a local write/push occurs. A poll that
// started before a bump must discard its result, since the remote data it
// fetched predates the user's local change and would clobber it.
let writeGeneration = 0
let pushesInFlight = 0
// Single-flight coalescing for pushes. pushJournal/pushNotes/pushTasks each do
// synchronous Automerge (loadDoc/saveDoc, WASM, main thread) + network. While
// one push runs, a second executePush would stack another Automerge spike on
// the main thread mid-type = the typing hitch. Instead we keep only the LATEST
// requested pushFn here and run it once the in-flight push settles (last write
// wins — an older snapshot is always superseded by the newer one anyway).
let coalescedPush = null
// In-flight guard: the poll scheduler is a 1s setInterval, but a single poll's
// network + Automerge merge work can take longer than 1s. Without this, the
// next tick fires a second pollRemote on top of the first (both pass the
// hash-changed check, since lastRemoteHash is only updated at the very end),
// stacking concurrent loadDoc/mergeDoc/saveDoc CPU spikes on the main thread —
// the typing hitch. One poll at a time; ticks that overlap are dropped.
let pollInFlight = false
// When true, the next pollRemote skips the modifiedTime hash check and
// fetches directly.
let forceNextPoll = true

export function notifyLocalWrite() {
  writeGeneration++
}

function setStatus(s) {
  if (status.state === s.state && status.retryIn === s.retryIn) return
  status = s
  listeners.forEach(fn => fn(s))
}

export function getSyncStatus() {
  return status
}

export function onSyncStatus(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function startSyncEngine(storeSetter, intervalMs, storeGetter) {
  if (running) return
  running = true
  _storeSetter = storeSetter
  _storeGetter = storeGetter || null
  pollIntervalMs = intervalMs || DEFAULT_POLL_INTERVAL
  retryCount = 0
  lastRemoteHash = null

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('focus', handleVisibility)

  if (!navigator.onLine) {
    setStatus({ state: 'offline' })
  } else {
    setStatus({ state: 'synced' })
    forceNextPoll = true
    startPolling(storeSetter)
  }
}

function handleVisibility() {
  if (!running) return
  if (document.visibilityState === 'hidden') return
  if (!navigator.onLine) return
  // Firefox (esp. mobile) freezes backgrounded tabs, so a push that was in
  // flight when the user navigated away can stall indefinitely. When the tab
  // comes back, flush any parked push before polling — otherwise device 2
  // won't see device 1's changes until device 1 makes another edit.
  if (pendingPush) {
    clearTimeout(retryTimer)
    clearInterval(countdownTimer)
    retryTimer = null
    countdownTimer = null
    retryCount = 0
    retryStartTime = 0
    setStatus({ state: 'syncing' })
    const fn = pendingPush
    pendingPush = null
    executePush(fn)
  }
  forceNextPoll = true
  pollRemote(_storeSetter)
}

export function stopSyncEngine() {
  running = false
  clearInterval(pollTimer)
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)
  pollTimer = null
  retryTimer = null
  countdownTimer = null
  pendingPush = null
  retryCount = 0
  lastRemoteHash = null
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  document.removeEventListener('visibilitychange', handleVisibility)
  window.removeEventListener('focus', handleVisibility)
  setStatus({ state: 'offline' })
}

export function retryNow() {
  if (!running) return
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)
  retryTimer = null
  countdownTimer = null
  retryCount = 0
  retryStartTime = 0

  if (pendingPush) {
    setStatus({ state: 'syncing' })
    const fn = pendingPush
    pendingPush = null
    executePush(fn)
  } else {
    setStatus({ state: 'syncing' })
    pollRemote(_storeSetter).then(() => {
      if (status.state === 'syncing') setStatus({ state: 'synced' })
    })
  }
}

async function ensureValidToken() {
  const token = await getStoredToken()
  if (token) {
    setAccessToken(token)
    return true
  }

  try {
    const refreshed = await trySilentRefresh()
    if (refreshed) {
      await storeToken(refreshed.token, refreshed.expiresIn)
      setAccessToken(refreshed.token)
      return true
    }
  } catch (e) {
    console.warn('Sync engine token refresh failed:', e)
  }
  return false
}

function handleOnline() {
  if (!running) return
  retryCount = 0
  retryStartTime = 0
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)

  if (pendingPush) {
    setStatus({ state: 'syncing' })
    const fn = pendingPush
    pendingPush = null
    executePush(fn)
  } else {
    setStatus({ state: 'synced' })
  }

  // Reconnect is a real "load" — force the next poll so it surfaces the spinner
  // and skips the hash short-circuit, like wake-from-focus does.
  forceNextPoll = true
  startPolling(_storeSetter)
}

function handleOffline() {
  if (!running) return
  clearInterval(pollTimer)
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)
  pollTimer = null
  setStatus({ state: 'offline' })
}

function startPolling(storeSetter) {
  _storeSetter = storeSetter
  clearInterval(pollTimer)
  pollTimer = setInterval(() => pollRemote(storeSetter), pollIntervalMs)
}

export function setPollInterval(ms) {
  pollIntervalMs = ms || DEFAULT_POLL_INTERVAL
  if (running && pollTimer) {
    startPolling(_storeSetter)
  }
}

/**
 * Force one full poll now and resolve when it settles. Unlike retryNow(), this
 * returns the poll promise so callers can pull-before-push (e.g. resuming from
 * manual offline: drain the remote into local Automerge docs first, so the
 * subsequent push merges on top of the other device's changes instead of
 * racing them). Requires the engine to be running (startSyncEngine first).
 */
export async function pullNow() {
  if (!running) return
  forceNextPoll = true
  await pollRemote(_storeSetter)
}

async function pollRemote(storeSetter) {
  if (!running || pushesInFlight > 0) return
  // Drop this tick if a previous poll is still running — see pollInFlight.
  if (pollInFlight) return
  pollInFlight = true
  const startGen = writeGeneration
  try {
    const ids = await getDriveFileIds()
    if (!ids) return
    // Phase B: poll relies on manifest + per-entity files. If the migration
    // hasn't run yet (initial connect flow handles it), defer until it has.
    if (!ids.notesFolderId || !ids.tasksFolderId || !ids.audioMetaFolderId) return

    const hasToken = await ensureValidToken()
    if (!hasToken) {
      setStatus({ state: 'error', message: 'Session expired', isAuth: true })
      return
    }

    let hash = null
    const forced = forceNextPoll
    if (forced) {
      forceNextPoll = false
    } else {
      hash = await getRemoteHash(ids)
      if (hash === lastRemoteHash) {
        // Probe: hash gate short-circuited this poll. If the laptop's task
        // changes are stuck, this is one place they'd be skipped — the manifest
        // modifiedTime already matched lastRemoteHash (e.g. stamped by our own
        // push's line-689 hash refresh) so we never even diff/fetch.
        logSync('poll hash-gate skip', { hash, lastRemoteHash })
        return
      }
    }

    // Only surface 'syncing' for forced polls — the ones the user perceives as a
    // real load: cold start, wake-from-focus, reconnect, manual sync. Routine
    // every-second background polls merge silently and settle on 'synced'
    // without flipping the status dot, so sitting on Today shows no flicker.
    if (forced) setStatus({ state: 'syncing' })

    // 1. Manifest diff — what entity ids changed since we last polled?
    const head = await readManifest(ids.rootId)
    const localLastSeq = await getLocalLastSeq()
    let changedByType = { task: new Map(), note: new Map(), audio: new Map(), journal: new Map(), config: new Map() }
    let coldStart = false
    let headSeq = 0
    if (!head) {
      // No manifest yet; treat like a cold start so we don't miss anything.
      coldStart = true
    } else {
      headSeq = head.manifest.seq || 0
      const diff = diffManifest(head.manifest, localLastSeq)
      if (diff.gap) {
        coldStart = true
      } else {
        for (const c of diff.changes || []) {
          const bucket = changedByType[c.type]
          if (!bucket) continue
          // Newest op wins (diffManifest already deduped per id).
          bucket.set(c.id, c)
        }
      }
    }

    // Probe: the seq floor + what this poll resolved to fetch. If the laptop's
    // tasks are stale, the decisive question is whether they appear in
    // `taskIds` here. Empty taskIds while headSeq advanced past their seq =
    // Theory A (localLastSeq already covered them, so they were never fetched).
    logSync('poll diff', {
      forced,
      coldStart,
      localLastSeq,
      headSeq,
      taskIds: Array.from(changedByType.task.keys()).map(id => id.slice(0, 8)),
      taskOps: Array.from(changedByType.task.values()).map(c => c.op),
      journalIds: Array.from(changedByType.journal.keys()),
    })

    // 2. Config is now a per-entity Automerge doc (config/config.bin). Only
    //    fetch it when the manifest flagged it (or on cold start) — no more
    //    blind every-poll read that clobbered freshly-saved local settings.
    const configDoc = await resolveConfigDoc(ids.configFolderId, coldStart, changedByType.config)

    // 3. Fetch the per-entity files that changed (or all, on cold start).
    //    Tasks + notes + journals: Phase C — Automerge .bin via resolve*Docs.
    //    Audio: Phase B per-id .json (own cutover session lands later).
    let taskDocs = []
    let noteDocs = []
    let audioDocs = []
    let journalDocs = []
    {
      const fetchChangedJson = async (folderId, bucket) => {
        const ids2 = Array.from(bucket.keys())
        if (!ids2.length) return []
        return readEntityFilesBatched(folderId, ids2.map(id => ({ id })))
      }
      const audioPromise = coldStart
        ? (async () => {
            const list = await listFolder(ids.audioMetaFolderId)
            const entries = list
              .map(f => {
                const m = /^(.+)\.json$/.exec(f.name || '')
                if (!m || m[1].startsWith('_')) return null
                return { id: m[1], fileId: f.id }
              })
              .filter(Boolean)
            return readEntityFilesBatched(ids.audioMetaFolderId, entries)
          })()
        : fetchChangedJson(ids.audioMetaFolderId, changedByType.audio)
      const [n, a, t, j] = await Promise.all([
        resolveNoteDocs(ids.notesFolderId, coldStart, changedByType.note),
        audioPromise,
        resolveTaskDocs(ids.tasksFolderId, coldStart, changedByType.task),
        resolveJournalDocs(ids.journalsFolderId, coldStart, changedByType.journal),
      ])
      noteDocs = n
      audioDocs = a
      taskDocs = t
      journalDocs = j
    }

    // A local write raced with our pull — discard, the user's edit is fresher.
    if (writeGeneration !== startGen || pushesInFlight > 0) {
      // Probe: bailed AFTER fetching docs but BEFORE merge. Nothing reached IDB
      // this poll, and seq was NOT advanced — a later poll should retry. If
      // tasks were fetched here, note them so we can see the retry land.
      logSync('poll guard-1 discard (pre-merge)', {
        genChanged: writeGeneration !== startGen,
        pushesInFlight,
        fetchedTaskIds: taskDocs.map(d => d.id.slice(0, 8)),
      })
      if (forced) setStatus({ state: 'synced' })
      return
    }

    // 4. Merge tasks + notes + journals via Automerge. Helpers persist merged
    // rows + bytes back to IDB internally (via put*WithDoc), so we just need
    // the resulting lists for the store update below.
    const mergedTasks = await mergeTaskDocs(taskDocs, changedByType.task)
    const mergedNotes = await mergeNoteDocs(noteDocs, changedByType.note)
    const mergedJournals = await mergeJournalDocs(journalDocs, changedByType.journal)

    // 5. Merge config (Automerge singleton). mergeConfigDoc persists the merged
    //    row + bytes to IDB; returns null when there was nothing to merge.
    const mergedConfig = await mergeConfigDoc(configDoc)

    // 7. Reconcile audio metadata (per-id files now).
    const audioTranscriptUpdates = []
    if (audioDocs.length > 0) {
      try {
        const localAudio = await getAllAudio()
        const localById = new Map(localAudio.map(a => [a.id, a]))
        for (const { id, doc: entry } of audioDocs) {
          const change = changedByType.audio.get(id)
          if (!entry) {
            if (change?.op === 'delete') {
              // Other device hard-deleted the meta. Mark local as deleted.
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
            if (entry.transcript || entry.transcriptSegments) audioTranscriptUpdates.push(entry.id)
            continue
          }
          const localDelT = new Date(local.deletedAt || 0).getTime()
          const remoteDelT = new Date(entry.deletedAt || 0).getTime()
          let nextDeleted = local.deleted || false
          let nextDeletedAt = local.deletedAt || null
          let nextSourceType = local.sourceType || null
          let nextSourceId = local.sourceId || null
          let nextSourceTitle = local.sourceTitle || null
          if (remoteDelT > localDelT) {
            nextDeleted = entry.deleted || false
            nextDeletedAt = entry.deletedAt || null
            nextSourceType = entry.sourceType || nextSourceType
            nextSourceId = entry.sourceId || nextSourceId
            nextSourceTitle = entry.sourceTitle || nextSourceTitle
          } else if (localDelT === 0 && remoteDelT === 0 && entry.deleted && !local.deleted) {
            nextDeleted = true
            nextSourceType = entry.sourceType || nextSourceType
            nextSourceId = entry.sourceId || nextSourceId
            nextSourceTitle = entry.sourceTitle || nextSourceTitle
          }
          const localT = new Date(local.transcribedAt || 0).getTime()
          const remoteT = new Date(entry.transcribedAt || 0).getTime()
          const localHasTranscript = !!(local.transcript || (Array.isArray(local.transcriptSegments) && local.transcriptSegments.length))
          const remoteHasTranscript = !!(entry.transcript || (Array.isArray(entry.transcriptSegments) && entry.transcriptSegments.length))
          const takeRemoteByTime = !!entry.transcribedAt && remoteT >= localT
          const takeRemoteByPresence = remoteHasTranscript && !localHasTranscript
          const takeRemote = takeRemoteByTime || takeRemoteByPresence
          const trashChanged = nextDeleted !== !!local.deleted || nextDeletedAt !== (local.deletedAt || null)
          if (!takeRemote && local.transcribedAt && !trashChanged) continue
          if (!remoteHasTranscript && !trashChanged) continue
          await putAudio({
            ...local,
            driveFileId: local.driveFileId || entry.driveFileId || null,
            transcript: takeRemote ? (entry.transcript || null) : local.transcript,
            transcriptModel: takeRemote ? (entry.transcriptModel || null) : local.transcriptModel,
            transcribedAt: takeRemote ? (entry.transcribedAt || null) : local.transcribedAt,
            transcriptSegments: takeRemote ? (entry.transcriptSegments || null) : local.transcriptSegments,
            deleted: nextDeleted,
            deletedAt: nextDeletedAt,
            sourceType: nextSourceType,
            sourceId: nextSourceId,
            sourceTitle: nextSourceTitle,
          }, { fromSync: true })
          if (takeRemote) audioTranscriptUpdates.push(entry.id)
        }
      } catch (e) {
        console.warn('Audio reconcile failed:', e.message || e)
      }
    }
    if (audioTranscriptUpdates.length > 0) {
      try {
        window.dispatchEvent(new CustomEvent('yajna:audio-updated', { detail: { ids: audioTranscriptUpdates } }))
      } catch { /* ignore */ }
    }

    // 8. If the currently-loaded day's journal was among the manifest changes
    //    (or this was a cold start), push the freshly merged row into the
    //    store so the open day re-renders. mergeJournalDocs has already
    //    persisted to IDB; we just need to refresh `currentDay`.
    let updatedDay = undefined
    const currentDate = _storeGetter ? _storeGetter()?.currentDay?.date : null
    if (currentDate) {
      const hit = mergedJournals.find(d => d?.date === currentDate)
      if (hit) updatedDay = hit
    }

    if (writeGeneration !== startGen || pushesInFlight > 0) {
      // Probe: bailed AFTER the IDB merge but BEFORE storeSetter + seq advance.
      // This is the suspected lethal guard: tasks ARE now in IDB, but the store
      // won't repaint AND localLastSeq is NOT advanced here (good — retry
      // possible). The danger is a later push stamping lastRemoteHash so the
      // hash gate skips every retry. mergedTaskCount tells us IDB got the data.
      logSync('poll guard-2 discard (post-merge, pre-store)', {
        genChanged: writeGeneration !== startGen,
        pushesInFlight,
        mergedTaskCount: mergedTasks.length,
        headSeq,
        localLastSeq,
      })
      if (forced) setStatus({ state: 'synced' })
      return
    }

    if (storeSetter) {
      const visibleTasks = mergedTasks.filter(t => !t.deleted)
      const visibleNotes = mergedNotes.filter(n => !n.deleted)
      // Diagnostic: which task ids was the store showing that this poll is about
      // to drop (or add)? A drop here is the "task vanishes for a few seconds"
      // moment. Only log when something actually changes, to keep it quiet.
      {
        const shown = _storeGetter?.()?.tasks || []
        const shownIds = new Set(shown.map(t => t.id))
        const nextIds = new Set(visibleTasks.map(t => t.id))
        const dropped = [...shownIds].filter(id => !nextIds.has(id)).map(id => id.slice(0, 8))
        const added = [...nextIds].filter(id => !shownIds.has(id)).map(id => id.slice(0, 8))
        if (dropped.length || added.length) {
          logSync('poll task store set', {
            dropped, added, coldStart,
            changed: Array.from(changedByType.task.keys()).map(id => id.slice(0, 8)),
          })
        }
      }
      const update = {
        tasks: visibleTasks,
        notes: visibleNotes,
      }
      // Only push config into the store when it actually merged this poll —
      // otherwise leave the in-memory config (and any unsaved local edit) alone.
      if (mergedConfig) {
        update.config = mergedConfig
      }
      if (updatedDay !== undefined) {
        update.currentDay = updatedDay
        // Only bump currentDayRev (which re-renders the open editor) when the
        // merged content actually differs from what's already shown. The merge
        // result for the open day is usually just our OWN saves echoing back
        // through Drive — content-identical, same updatedAt. Bumping on that
        // echo rebuilds the doc mid-type = the typing lag. Same guard
        // loadJournal already uses; the poll-merge path was missing it.
        const shown = _storeGetter?.()?.currentDay
        const contentChanged =
          !shown ||
          shown.date !== updatedDay.date ||
          blocksToHtml(shown.blocks) !== blocksToHtml(updatedDay.blocks) ||
          (shown.reviewedAt || null) !== (updatedDay.reviewedAt || null)
        // Probe: did a poll-merged remote journal reach the OPEN editor, or get
        // dropped as a same-content echo? This is the blind spot in the "wrote
        // on laptop, didn't appear on phone" reports — the merge can land in IDB
        // (Probe 1) yet never bump currentDayRev, so the open day never repaints.
        logSync('poll journal render decision', {
          date: updatedDay.date,
          journalChanged: changedByType.journal.has(updatedDay.date),
          contentChanged,
          coldStart,
          willBumpRev: contentChanged,
        })
        if (contentChanged) {
          update.currentDayRev = (_storeGetter?.()?.currentDayRev ?? 0) + 1
        } else {
          // Don't even replace currentDay with a fresh-but-identical reference;
          // leave the in-memory doc (and any unsaved edit) untouched.
          delete update.currentDay
        }
      }
      storeSetter(update)
    }

    // Advance localLastSeq to the manifest head. On cold start we adopt the
    // head as-is — we just enumerated every entity file, so anything older is
    // covered by the per-id merges above.
    //
    // BUT: a per-id fetch can come back null when the manifest flagged that id
    // as an UPSERT (Drive read miss / eventual consistency). The merge helpers
    // skip such ids (only deletes write a tombstone), so the entity never lands
    // in IDB. If we still advanced the floor to headSeq, that change would be
    // marked "seen" and never retried — a permanent silent drop (the "missing
    // dismissed/done task" bug; confirmed via binOnDrive=true on a missing id).
    //
    // So cap the advance to just below the lowest unresolved upsert seq. The
    // next poll re-diffs from there and refetches the id (the transient miss is
    // gone by then). Deletes with null bytes are intentional (tombstone written
    // above), so they don't hold the floor back. Cold start enumerates the full
    // folder, so there are no manifest-diff "unresolved" ids to guard.
    let advanceTo = headSeq
    if (!coldStart) {
      const resolvedBytes = new Map() // `${type}:${id}` -> hasBytes
      for (const { id, bytes } of taskDocs) resolvedBytes.set(`task:${id}`, !!bytes)
      for (const { id, bytes } of noteDocs) resolvedBytes.set(`note:${id}`, !!bytes)
      for (const { id, bytes } of journalDocs) resolvedBytes.set(`journal:${id}`, !!bytes)
      if (configDoc) resolvedBytes.set(`config:${configDoc.id}`, !!configDoc.bytes)
      let minUnresolvedSeq = Infinity
      const unresolved = []
      for (const type of ['task', 'note', 'journal', 'config']) {
        for (const [id, change] of changedByType[type]) {
          if (change.op === 'delete') continue
          if (resolvedBytes.get(`${type}:${id}`) === false) {
            const seq = change.seq || 0
            if (seq > 0 && seq < minUnresolvedSeq) minUnresolvedSeq = seq
            unresolved.push(`${type}:${id.slice(0, 8)}@${seq}`)
          }
        }
      }
      if (minUnresolvedSeq !== Infinity) {
        advanceTo = Math.min(headSeq, minUnresolvedSeq - 1)
        // Force the NEXT poll to re-diff (bypass the modifiedTime hash gate):
        // nothing on Drive will change to bump the hash, so without this the
        // held-back id would only retry when some unrelated change moves the
        // manifest. The transient null read is gone by next tick, so the
        // refetch succeeds and the floor finally advances past it.
        forceNextPoll = true
        logSync('poll seq advance HELD BACK (unresolved upsert)', {
          headSeq, advanceTo, unresolved,
        })
      }
    }
    if (advanceTo > localLastSeq) {
      // Probe: seq floor advanced after a full poll. From here on, any change
      // with seq <= advanceTo is considered "seen" and diffManifest will skip it.
      logSync('poll seq advance', { from: localLastSeq, to: advanceTo })
      await setLocalLastSeq(advanceTo)
    }

    if (forced) {
      try {
        lastRemoteHash = await getRemoteHash(ids)
      } catch {
        // best-effort
      }
    } else {
      lastRemoteHash = hash
    }
    // Forced polls showed 'syncing' above; settle them back. Silent background
    // polls never changed the status, so leave it untouched (no status churn).
    if (forced) setStatus({ state: 'synced' })
  } catch (e) {
    console.warn('Poll failed:', e.message || e)
    if (isAuthError(e)) {
      // Auth dead and silent refresh can't recover (withAuthRetry already
      // tried). Stop polling so we don't ping Drive every second with a
      // doomed token — the UI is already showing 'Session expired'.
      setStatus({ state: 'error', message: 'Session expired', isAuth: true })
      clearInterval(pollTimer)
      pollTimer = null
    } else if (!navigator.onLine) {
      setStatus({ state: 'offline' })
    }
  } finally {
    pollInFlight = false
  }
}

/**
 * Cheap "did anything change?" probe: modifiedTime of manifest.json.
 * The manifest covers tasks/notes/audio/journals/config — every entity push
 * (config included, now that it's an Automerge doc) appends a manifest entry,
 * so the manifest's modifiedTime catches all of them.
 */
async function getRemoteHash(ids) {
  const token = window.gapi?.client?.getToken()?.access_token
  if (!token) return null

  const manifestFileId = await findFile(ids.rootId, 'manifest.json').catch(() => null)
  const fileIds = []
  if (manifestFileId) fileIds.push(manifestFileId)
  if (!fileIds.length) return null

  const times = await Promise.all(
    fileIds.map(async (fid) => {
      try {
        const res = await withAuthRetry(() => window.gapi.client.drive.files.get({
          fileId: fid,
          fields: 'modifiedTime',
        }))
        return res.result.modifiedTime
      } catch (e) {
        if (isAuthError(e)) throw e
        return null
      }
    })
  )
  return times.join('|')
}

function scheduleRetry(pushFn) {
  pendingPush = pushFn
  if (!navigator.onLine) {
    setStatus({ state: 'offline' })
    return
  }

  if (retryCount === 0) {
    retryStartTime = Date.now()
  }

  const elapsed = Date.now() - retryStartTime
  if (elapsed > 30000) {
    console.warn('Sync retry limit reached (30s). Staying offline.')
    setStatus({ state: 'offline' })
    return
  }

  const delayMs = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_MAX_MS)
  retryCount++
  let remaining = Math.ceil(delayMs / 1000)
  setStatus({ state: 'waiting', retryIn: remaining })

  clearInterval(countdownTimer)
  countdownTimer = setInterval(() => {
    remaining--
    if (remaining > 0) {
      setStatus({ state: 'waiting', retryIn: remaining })
    }
  }, 1000)

  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    clearInterval(countdownTimer)
    countdownTimer = null
    if (!running) return
    if (!navigator.onLine) {
      setStatus({ state: 'offline' })
      return
    }
    const fn = pendingPush
    pendingPush = null
    executePush(fn)
  }, delayMs)
}

async function executePush(pushFn) {
  if (!pushFn) return
  // Single-flight: if a push is already running, don't start a second on the
  // main thread. Park the latest fn; the running push drains it when it ends.
  if (pushesInFlight > 0) {
    coalescedPush = pushFn
    return
  }
  if (!navigator.onLine) {
    scheduleRetry(pushFn)
    return
  }

  const hasToken = await ensureValidToken()
  if (!hasToken) {
    pendingPush = pushFn
    setStatus({ state: 'error', message: 'Session expired', isAuth: true })
    return
  }

  setStatus({ state: 'syncing' })
  pushesInFlight++
  try {
    await pushFn()
    retryCount = 0
    retryStartTime = 0
    pendingPush = null
    setStatus({ state: 'synced' })
    try {
      const ids = await getDriveFileIds()
      if (ids) {
        const before = lastRemoteHash
        lastRemoteHash = await getRemoteHash(ids)
        // Probe: a completed PUSH just stamped lastRemoteHash to the current
        // manifest time. If a concurrent poll had skipped task fetch/store, this
        // stamp can make the next poll's hash gate skip the retry — the prime
        // suspect for "stale even though laptop changed tasks". The manifest
        // time now reflects BOTH our push and any laptop task change.
        logSync('push hash stamp', { before, after: lastRemoteHash })
      }
    } catch { /* best-effort hash refresh */ }
  } catch (e) {
    console.warn('Push failed:', e.message || e)
    if (isAuthError(e)) {
      pendingPush = pushFn
      setStatus({ state: 'error', message: 'Session expired', isAuth: true })
    } else {
      scheduleRetry(pushFn)
    }
  } finally {
    pushesInFlight--
    // Drain a push that arrived while we were busy. Runs exactly one (the
    // latest) — if more piled up they already overwrote coalescedPush, so we
    // never replay a stale snapshot.
    if (coalescedPush && pushesInFlight === 0) {
      const next = coalescedPush
      coalescedPush = null
      executePush(next)
    }
  }
}

export function withRetry(pushFn) {
  return () => {
    writeGeneration++
    clearTimeout(retryTimer)
    clearInterval(countdownTimer)
    retryTimer = null
    countdownTimer = null
    pendingPush = null
    return executePush(pushFn)
  }
}
