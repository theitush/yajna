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
  flushPendingSync, hasPendingSync,
  findUnresolvedUpserts, findColdPullFailures,
} from './sync'
import { readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { blocksToHtml } from '../lib/blocks'
import { buildReviewsIndex } from '../lib/review'
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
let lastRemoteHash = null
// Highest manifest seq we've observed (from the last manifest read). The hash
// gate below skips a poll when the manifest's modifiedTime is unchanged — but
// that's only safe if we're actually CAUGHT UP. A device's own push stamps
// lastRemoteHash to a modifiedTime that may already include the OTHER device's
// writes we haven't pulled (seq floor < head), so hash-equality alone would
// suppress catch-up forever (the "mobile journal goes stale" bug). We gate on
// hash AND localLastSeq >= lastKnownHeadSeq, so being behind always re-polls.
let lastKnownHeadSeq = 0
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
// Cold-pull retry pacing. An incomplete cold pull keeps the seq floor where it
// was, so every subsequent poll re-detects the gap — without a backoff that's
// a full folder re-enumeration every 1s tick, hammering Drive on exactly the
// flaky connection that caused the failure. Exponential (RETRY_BASE_MS →
// RETRY_MAX_MS); forced polls (reconnect, tab focus, manual retry) bypass it,
// since those are the "connection might be back" moments.
let coldRetryAt = 0
let coldRetryCount = 0

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
  lastKnownHeadSeq = 0
  coldRetryAt = 0
  coldRetryCount = 0

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
    // Drain edits stranded by a previous session. Dirty tokens persist in IDB,
    // but the push that was supposed to ship them died with the page — without
    // this, an offline-created task never pushes until this device happens to
    // run pushTasks again (proven: two tasks created offline on 2026-06-11
    // never left the phone).
    flushStranded()
  }
}

/**
 * Push whatever the persisted dirty set still holds. The dirty tokens in IDB
 * are the durable record of unpushed work; any in-memory closure parked for
 * retry dies with the page (tab kill, reload, background freeze), so every
 * recovery path — boot, reconnect, tab focus, retry timer, manual retry —
 * must re-derive its work from here instead. No-op when nothing is dirty.
 */
async function flushStranded() {
  const pending = await hasPendingSync().catch(() => false)
  logSync('flushStranded', { pending, inFlight: pushesInFlight })
  if (pending) executePush(flushPendingSync)
}

function handleVisibility() {
  if (!running) return
  if (document.visibilityState === 'hidden') return
  if (!navigator.onLine) return
  // Firefox (esp. mobile) freezes backgrounded tabs, so a push that was in
  // flight when the user navigated away can stall indefinitely. When the tab
  // comes back, flush anything still dirty before polling — otherwise device 2
  // won't see device 1's changes until device 1 makes another edit.
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)
  retryTimer = null
  countdownTimer = null
  retryCount = 0
  retryStartTime = 0
  flushStranded()
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
  retryCount = 0
  lastRemoteHash = null
  lastKnownHeadSeq = 0
  coldRetryAt = 0
  coldRetryCount = 0
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

  setStatus({ state: 'syncing' })
  flushStranded()
  pollRemote(_storeSetter).then(() => {
    if (status.state === 'syncing') setStatus({ state: 'synced' })
  })
}

// Returns:
//   'ok'      — a usable access token is in hand.
//   'expired' — the refresh worker said no (401 / no blob). Truly signed out.
//   'network' — couldn't reach the worker (transport error). Transient: the
//               token isn't dead, we just can't refresh it right now. Retry.
// Conflating the last two is what made wake-from-sleep show a false "Session
// expired" — the worker fetch fails at the network layer (Status code: null,
// CORS did not succeed), not with a 401.
async function ensureValidToken() {
  const token = await getStoredToken()
  if (token) {
    setAccessToken(token)
    return 'ok'
  }

  try {
    const refreshed = await trySilentRefresh()
    if (refreshed) {
      await storeToken(refreshed.token, refreshed.expiresIn)
      setAccessToken(refreshed.token)
      return 'ok'
    }
    // null = worker reachable but rejected the blob (401) or none stored.
    return 'expired'
  } catch (e) {
    // Threw = the worker was unreachable (offline / wake-from-sleep / CORS).
    console.warn('Sync engine token refresh network error (will retry):', e)
    return 'network'
  }
}

function handleOnline() {
  if (!running) return
  retryCount = 0
  retryStartTime = 0
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)

  // flushStranded flips status to 'syncing' itself (via executePush) only when
  // the dirty set actually has work.
  setStatus({ state: 'synced' })
  flushStranded()

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
  // Hoisted out of the try so the catch can pace a cold pull that THREW
  // mid-enumeration (same backoff as one that completed with holes).
  let coldStart = false
  try {
    const ids = await getDriveFileIds()
    if (!ids) return
    // Phase B: poll relies on manifest + per-entity files. If the migration
    // hasn't run yet (initial connect flow handles it), defer until it has.
    if (!ids.notesFolderId || !ids.tasksFolderId || !ids.audioMetaFolderId) return

    const tokenState = await ensureValidToken()
    if (tokenState === 'expired') {
      setStatus({ state: 'error', message: 'Session expired', isAuth: true })
      return
    }
    if (tokenState === 'network') {
      // Worker unreachable (typically wake-from-sleep before Wi-Fi is back).
      // The token isn't dead — bail this tick and let the next poll / online
      // event refresh once the network returns. No banner change; the prior
      // status stands and the engine self-heals without a manual reload.
      return
    }

    let hash = null
    const forced = forceNextPoll
    if (forced) {
      forceNextPoll = false
    } else {
      hash = await getRemoteHash(ids)
      if (hash === lastRemoteHash) {
        // Hash gate: the manifest's modifiedTime is unchanged since we last
        // stamped it. That only means "caught up" if our seq floor has actually
        // reached the head we last saw — otherwise we have unpulled changes the
        // hash can't see (e.g. our own push stamped a modifiedTime that already
        // included the other device's writes). Skip ONLY when caught up; if
        // we're behind, fall through and re-diff so we finally pull them.
        const seqNow = await getLocalLastSeq()
        if (seqNow >= lastKnownHeadSeq) {
          return
        }
        logSync('poll hash-gate bypass (behind head)', {
          localLastSeq: seqNow, lastKnownHeadSeq,
        })
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
    let headSeq = 0
    if (!head) {
      // No manifest yet; treat like a cold start so we don't miss anything.
      coldStart = true
    } else {
      headSeq = head.manifest.seq || 0
      // Remember the head so the hash gate (above, next poll) knows whether
      // we're caught up. Monotonic: never let a transient lower read regress it.
      if (headSeq > lastKnownHeadSeq) lastKnownHeadSeq = headSeq
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

    // A previous cold pull was incomplete (head not adopted), so this tick
    // would re-enumerate the entire Drive folder. Wait out the backoff —
    // forced polls (reconnect/focus/manual) skip it and retry immediately.
    if (coldStart && !forced && Date.now() < coldRetryAt) {
      return
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
      // Draft tasks live only in store memory (never in IDB/Drive), so a
      // wholesale store set from merged rows would silently drop them —
      // carry them over.
      const draftTasks = (_storeGetter?.()?.tasks || []).filter(t => t.draft)
      const visibleTasks = [...mergedTasks.filter(t => !t.deleted), ...draftTasks]
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
      // A journal merged this poll (reviewedAt flip, edited content, or a new
      // past day) must refresh the Review surfaces — the badge in the Sidebar and
      // the ReviewPage/SearchPage lists. They read the `reviews` map plus the
      // journalDocs they reload whenever `reviewVersion` changes; the poll touched
      // NEITHER, so a day reviewed (or unreviewed) on another device stayed stale
      // here until a manual refresh (which rebuilds both at boot). Rebuild the map
      // from the freshly merged rows — a full rebuild so an UNreview elsewhere
      // clears the stale timestamp too — and bump the version to reload.
      if (changedByType.journal.size > 0) {
        update.reviews = buildReviewsIndex(mergedJournals)
        update.reviewVersion = (_storeGetter?.()?.reviewVersion ?? 0) + 1
        // Probe: confirms a cross-device review/unreview refreshed the badge
        // WITHOUT a manual refresh. Counts only — no entry text — PII-free.
        logSync('poll reviews refresh', {
          changedDates: Array.from(changedByType.journal.keys()),
          reviewedDays: Object.keys(update.reviews).length,
        })
      }
      storeSetter(update)
    }

    // Advance localLastSeq to the manifest head — unless something this poll
    // was supposed to fetch didn't arrive. A per-id fetch can come back null
    // when the manifest flagged that id as an UPSERT (Drive read miss or
    // fetch failure). The merge helpers skip such ids, so the entity never
    // lands in IDB. If we still advanced the floor to headSeq, that change
    // would be marked "seen" and never retried — a permanent silent drop.
    //
    // Diff path: cap the advance to just below the lowest unresolved upsert
    // seq (findUnresolvedUpserts, shared with the boot merge) and retry next
    // poll. Cold path: no per-change seqs exist, so adopting the head is
    // all-or-nothing — any download failure keeps the old floor, the gap
    // re-detects, and the whole pull re-runs under coldRetryAt's backoff
    // until one clean pass.
    let advanceTo = headSeq
    let heldBack = false
    if (coldStart) {
      const { failures, errSample } = findColdPullFailures({
        task: taskDocs,
        note: noteDocs,
        journal: journalDocs,
        config: configDoc ? [configDoc] : [],
      })
      if (failures.length) {
        heldBack = true
        advanceTo = localLastSeq
        coldRetryCount++
        coldRetryAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** coldRetryCount, RETRY_MAX_MS)
        logSync('poll cold pull INCOMPLETE — head NOT adopted', {
          headSeq,
          failureCount: failures.length,
          failures: failures.slice(0, 30),
          errSample,
          retryInMs: coldRetryAt - Date.now(),
        })
      } else {
        coldRetryCount = 0
        coldRetryAt = 0
      }
    } else {
      const { minSeq, unresolved, errSample } = findUnresolvedUpserts(changedByType, {
        task: taskDocs,
        note: noteDocs,
        journal: journalDocs,
        config: configDoc ? [configDoc] : [],
      })
      if (minSeq !== Infinity) {
        advanceTo = Math.min(headSeq, minSeq - 1)
        heldBack = true
        // Force the NEXT poll to re-diff (bypass the modifiedTime hash gate):
        // nothing on Drive will change to bump the hash, so without this the
        // held-back id would only retry when some unrelated change moves the
        // manifest. The transient null read is gone by next tick, so the
        // refetch succeeds and the floor finally advances past it.
        forceNextPoll = true
        logSync('poll seq advance HELD BACK (unresolved upsert)', {
          headSeq, advanceTo, unresolved, errSample,
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
    // A held-back poll is NOT synced — changes we know about failed to fetch
    // and are pending retry — so keep showing 'syncing' instead of a lying
    // green dot (the next poll is already forced).
    if (heldBack) setStatus({ state: 'syncing' })
    else if (forced) setStatus({ state: 'synced' })

    // If the boot cold-pull overlay is still up (the initial pull finished
    // with holes), reflect this pass's outcome: a clean cold pull unlocks the
    // app; another incomplete one keeps it locked in "retrying" mode.
    if (coldStart && storeSetter && _storeGetter?.()?.coldPull?.active) {
      storeSetter({
        coldPull: heldBack
          ? { active: true, retrying: true, progress: {} }
          : { active: false, retrying: false, progress: {} },
      })
    }
  } catch (e) {
    console.warn('Poll failed:', e.message || e)
    if (coldStart) {
      // The pull threw mid-flight (e.g. a folder listing died). Same pacing
      // as an incomplete pass — don't re-enumerate everything next 1s tick.
      coldRetryCount++
      coldRetryAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** coldRetryCount, RETRY_MAX_MS)
    }
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

function scheduleRetry() {
  if (!navigator.onLine) {
    setStatus({ state: 'offline' })
    return
  }

  if (retryCount === 0) {
    retryStartTime = Date.now()
  }

  const elapsed = Date.now() - retryStartTime
  if (elapsed > 30000) {
    // Giving up is safe: the unpushed work lives in the persisted dirty set,
    // and the next reconnect/focus/boot flushStranded retries it.
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
    // Retry from the durable dirty set, not the closure that failed — it's a
    // superset of that closure's work and re-reads current local state.
    executePush(flushPendingSync)
  }, delayMs)
}

async function executePush(pushFn) {
  if (!pushFn) return
  // Single-flight: if a push is already running, don't start a second on the
  // main thread. Park the latest fn; the running push drains it when it ends.
  if (pushesInFlight > 0) {
    // PROBE: last-writer-wins park is type-blind across buckets. If a pushTasks
    // is parked and then overwritten by a pushJournal before it runs, the task
    // push is silently dropped. Surface every park + every overwrite so a phone
    // log can prove/disprove the "journal beautiful, tasks stranded" theory.
    logSync('executePush PARK', {
      incoming: pushFn.label || pushFn.name || 'anon',
      overwriting: coalescedPush ? (coalescedPush.label || coalescedPush.name || 'anon') : null,
      dropped: !!coalescedPush,
    })
    coalescedPush = pushFn
    return
  }
  if (!navigator.onLine) {
    scheduleRetry()
    return
  }

  const tokenState = await ensureValidToken()
  if (tokenState === 'expired') {
    // No parking needed: the dirty set holds the work; after re-login the
    // boot/retryNow flushStranded ships it.
    setStatus({ state: 'error', message: 'Session expired', isAuth: true })
    return
  }
  if (tokenState === 'network') {
    // Worker unreachable, not signed out. The work is safe in the dirty set;
    // back off and let reconnect/focus flushStranded retry once we're online.
    scheduleRetry()
    return
  }

  setStatus({ state: 'syncing' })
  pushesInFlight++
  try {
    await pushFn()
    retryCount = 0
    retryStartTime = 0
    setStatus({ state: 'synced' })
    // A push advanced the manifest head past our local seq floor (our own
    // changes, and possibly the OTHER device's writes that landed since our
    // last poll). We must NOT stamp lastRemoteHash to the current modifiedTime:
    // that's exactly what made the next poll's hash gate skip catch-up, leaving
    // the device stale ("mobile journal won't update"). Instead force the next
    // poll to re-diff. It re-reads the manifest, refreshes lastKnownHeadSeq,
    // advances our seq floor past our own (content-identical) push, and pulls
    // anything the other device wrote. One extra poll cycle, always correct.
    forceNextPoll = true
    logSync('push done -> force next poll', {})
  } catch (e) {
    console.warn('Push failed:', e.message || e)
    if (isAuthError(e)) {
      setStatus({ state: 'error', message: 'Session expired', isAuth: true })
    } else {
      scheduleRetry()
    }
  } finally {
    pushesInFlight--
    // Drain a push that arrived while we were busy. Runs exactly one (the
    // latest) — if more piled up they already overwrote coalescedPush, so we
    // never replay a stale snapshot.
    if (coalescedPush && pushesInFlight === 0) {
      const next = coalescedPush
      coalescedPush = null
      logSync('executePush DRAIN parked', { fn: next.label || next.name || 'anon' })
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
    return executePush(pushFn)
  }
}
