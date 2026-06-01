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
// When true, the next pollRemote skips the modifiedTime hash check and
// fetches directly.
let forceNextPoll = true
// Suppresses repeated steady-state "hash unchanged" debug log spam.
let _shortCircuitLogged = false

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

async function pollRemote(storeSetter) {
  if (!running || pushesInFlight > 0) return
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
        // Don't log the steady-state no-op every second — it floods the ring
        // buffer. Only log the first short-circuit after a real change.
        if (!_shortCircuitLogged) {
          logSync('poll short-circuit: remote hash unchanged (further repeats suppressed)', { hash })
          _shortCircuitLogged = true
        }
        return
      }
      _shortCircuitLogged = false
      logSync('poll proceeding: remote hash changed', { hash, prev: lastRemoteHash })
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
    logSync('manifest diff', {
      headSeq, localLastSeq, coldStart,
      changed: Object.fromEntries(Object.entries(changedByType).map(([t, m]) => [t, [...m.keys()]])),
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
      logSync('poll result DISCARDED by writeGeneration guard', {
        startGen, writeGeneration, pushesInFlight,
        wouldHaveMerged: Object.fromEntries(Object.entries(changedByType).map(([t, m]) => [t, [...m.keys()]])),
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
      if (forced) setStatus({ state: 'synced' })
      return
    }

    if (storeSetter) {
      const visibleTasks = mergedTasks.filter(t => !t.deleted)
      const visibleNotes = mergedNotes.filter(n => !n.deleted)
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
        // External origin (remote merge) → bump the rev so the open editor
        // re-renders. Local saves never reach here, so the editor never
        // reacts to the echo of its own write.
        update.currentDayRev = (_storeGetter?.()?.currentDayRev ?? 0) + 1
      }
      storeSetter(update)
    }

    // Advance localLastSeq to the manifest head. On cold start we adopt the
    // head as-is — we just enumerated every entity file, so anything older is
    // covered by the per-id merges above.
    if (headSeq > localLastSeq) {
      logSync('localLastSeq advance', {
        from: localLastSeq, to: headSeq, coldStart,
        mergedJournals: mergedJournals.map(d => d?.date),
        fetchedJournalIds: [...changedByType.journal.keys()],
      })
      await setLocalLastSeq(headSeq)
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
      if (ids) lastRemoteHash = await getRemoteHash(ids)
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
