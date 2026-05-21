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
  getDriveFileIds, readJsonFile, findFile,
  listFolder, readEntityFilesBatched,
} from './drive'
import {
  putConfig, putJournal,
  getAllAudio, putAudio, getJournal,
} from './db'
import { getStoredToken, trySilentRefresh, storeToken, setAccessToken, isAuthError, withAuthRetry } from './auth'
import { mergeDayDoc, resolveTaskDocs, mergeTaskDocs, resolveNoteDocs, mergeNoteDocs } from './sync'
import { readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { dayKey } from '../lib/dates'

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
// date (YYYY-MM-DD) → Drive fileId for the currently-loaded day's journal.
const journalFileIdCache = new Map()

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
    let journalFileId = null
    const forced = forceNextPoll
    if (forced) {
      forceNextPoll = false
      journalFileId = await getJournalFileIdForCurrentDay(ids)
    } else {
      const res = await getRemoteHash(ids)
      hash = res.hash
      journalFileId = res.journalFileId
      if (hash === lastRemoteHash) return
    }

    setStatus({ state: 'syncing' })

    // 1. Manifest diff — what entity ids changed since we last polled?
    const head = await readManifest(ids.rootId)
    const localLastSeq = await getLocalLastSeq()
    let changedByType = { task: new Map(), note: new Map(), audio: new Map() }
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

    // 2. Config (still a single file — small, no per-entity model for config).
    const remoteConfig = await readJsonFile(ids.configFileId).catch(() => ({}))

    // 3. Fetch the per-entity files that changed (or all, on cold start).
    //    Tasks + notes: Phase C — Automerge .bin via resolve*Docs helpers.
    //    Audio: Phase B per-id .json (own cutover session lands later).
    let taskDocs = []
    let noteDocs = []
    let audioDocs = []
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
      const [n, a, t] = await Promise.all([
        resolveNoteDocs(ids.notesFolderId, coldStart, changedByType.note),
        audioPromise,
        resolveTaskDocs(ids.tasksFolderId, coldStart, changedByType.task),
      ])
      noteDocs = n
      audioDocs = a
      taskDocs = t
    }

    // A local write raced with our pull — discard, the user's edit is fresher.
    if (writeGeneration !== startGen || pushesInFlight > 0) {
      setStatus({ state: 'synced' })
      return
    }

    // 4. Merge tasks + notes via Automerge. Both helpers persist merged rows
    // + bytes back to IDB internally (via put*WithDoc), so we just need the
    // resulting lists for the store update below.
    const mergedTasks = await mergeTaskDocs(taskDocs, changedByType.task)
    const mergedNotes = await mergeNoteDocs(noteDocs, changedByType.note)

    // 5. Persist config (tasks + notes already persisted).
    await putConfig(remoteConfig || {})

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

    // 8. Pull the currently-loaded day's journal — block-level merge.
    let updatedDay = undefined
    if (journalFileId) {
      const remoteDoc = await readJsonFile(journalFileId)
      if (remoteDoc?.date) {
        const localDoc = await getJournal(remoteDoc.date)
        const mergedDoc = localDoc ? mergeDayDoc(localDoc, remoteDoc) : remoteDoc
        await putJournal(mergedDoc)
        updatedDay = mergedDoc
      }
    }

    if (writeGeneration !== startGen || pushesInFlight > 0) {
      setStatus({ state: 'synced' })
      return
    }

    if (storeSetter) {
      const visibleTasks = mergedTasks.filter(t => !t.deleted)
      const visibleNotes = mergedNotes.filter(n => !n.deleted)
      const update = {
        tasks: visibleTasks,
        notes: visibleNotes,
        config: remoteConfig || {},
      }
      if (updatedDay !== undefined) {
        update.currentDay = updatedDay
      }
      storeSetter(update)
    }

    // Advance localLastSeq to the manifest head. On cold start we adopt the
    // head as-is — we just enumerated every entity file, so anything older is
    // covered by the per-id merges above.
    if (headSeq > localLastSeq) {
      await setLocalLastSeq(headSeq)
    }

    if (forced) {
      try {
        lastRemoteHash = (await getRemoteHash(ids)).hash
      } catch {
        // best-effort
      }
    } else {
      lastRemoteHash = hash
    }
    setStatus({ state: 'synced' })
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

async function getJournalFileIdForCurrentDay(ids) {
  if (!ids?.journalsFolderId || !_storeGetter) return null
  const date = _storeGetter()?.currentDay?.date
  if (!date) return null
  const key = dayKey(date)
  if (journalFileIdCache.has(key)) return journalFileIdCache.get(key)
  try {
    const fid = await findFile(ids.journalsFolderId, `${key}.json`)
    if (fid) journalFileIdCache.set(key, fid)
    return fid
  } catch (e) {
    if (isAuthError(e)) throw e
    return null
  }
}

/**
 * Cheap "did anything change?" probe: modifiedTime of manifest.json,
 * config.json, and today's journal file. Manifest covers tasks/notes/audio.
 */
async function getRemoteHash(ids) {
  const token = window.gapi?.client?.getToken()?.access_token
  if (!token) return { hash: null, journalFileId: null }

  const manifestFileId = await findFile(ids.rootId, 'manifest.json').catch(() => null)
  const fileIds = []
  if (manifestFileId) fileIds.push(manifestFileId)
  if (ids.configFileId) fileIds.push(ids.configFileId)

  const journalFileId = await getJournalFileIdForCurrentDay(ids)
  if (journalFileId) fileIds.push(journalFileId)

  if (!fileIds.length) return { hash: null, journalFileId }

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
  return { hash: times.join('|'), journalFileId }
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
      if (ids) lastRemoteHash = (await getRemoteHash(ids)).hash
    } catch {}
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
