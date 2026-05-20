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
import { getDriveFileIds, readJsonFile, findFile } from './drive'
import { putTasks, putNotes, putConfig, putJournal, getAllAudio, putAudio, getAllNotesRaw, getJournal } from './db'
import { getStoredToken, trySilentRefresh, storeToken, setAccessToken, isAuthError } from './auth'
import { mergeDayDoc } from './sync'
import { mergeBlocks, htmlToBlocks, purgeOldBlockTombstones } from '../lib/blocks'
import { dayKey } from '../lib/dates'

const BLOCK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
    const [tasks, notes, config, audioIndex] = await Promise.all([
      readJsonFile(ids.tasksFileId),
      readJsonFile(ids.notesFileId),
      readJsonFile(ids.configFileId),
      ids.audioIndexFileId ? readJsonFile(ids.audioIndexFileId).catch(() => []) : Promise.resolve([]),
    ])

    // A local write raced with our pull — discard, the user's edit is fresher.
    // Don't update lastRemoteHash either; let the next poll re-evaluate.
    if (writeGeneration !== startGen || pushesInFlight > 0) {
      setStatus({ state: 'synced' })
      return
    }

    // Safe notes merge at the block level (see notes in sync.js).
    const remoteNotesArr = Array.isArray(notes) ? notes : []
    const localNotesRaw = await getAllNotesRaw()
    const localNotesById = new Map(localNotesRaw.map(n => [n.id, n]))
    const mergedNotes = remoteNotesArr.map(remoteNote => {
      const localNote = localNotesById.get(remoteNote.id)
      if (!localNote || localNote.deleted || remoteNote.deleted) return remoteNote
      const localBlocks = Array.isArray(localNote.blocks) && localNote.blocks.length
        ? localNote.blocks
        : htmlToBlocks(localNote.body || '')
      const remoteBlocks = Array.isArray(remoteNote.blocks) && remoteNote.blocks.length
        ? remoteNote.blocks
        : htmlToBlocks(remoteNote.body || '')
      const cutoff = new Date(Date.now() - BLOCK_TOMBSTONE_TTL_MS).toISOString()
      const blocks = purgeOldBlockTombstones(mergeBlocks(localBlocks, remoteBlocks), cutoff)
      const localT = new Date(localNote.updatedAt || 0).getTime()
      const remoteT = new Date(remoteNote.updatedAt || 0).getTime()
      const winner = remoteT >= localT ? remoteNote : localNote
      const out = { ...winner, blocks }
      delete out.body
      return out
    })
    const remoteIds = new Set(remoteNotesArr.map(n => n.id))
    for (const n of localNotesRaw) {
      if (!remoteIds.has(n.id)) mergedNotes.push(n)
    }

    await Promise.all([
      putTasks(Array.isArray(tasks) ? tasks : []),
      putNotes(mergedNotes),
      putConfig(config || {}),
    ])

    // Reconcile audio index (unchanged from prior behaviour).
    const audioTranscriptUpdates = []
    if (Array.isArray(audioIndex) && audioIndex.length > 0) {
      try {
        const localAudio = await getAllAudio()
        const localById = new Map(localAudio.map(a => [a.id, a]))
        for (const entry of audioIndex) {
          if (!entry?.id) continue
          const local = localById.get(entry.id)
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
            })
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
          })
          if (takeRemote) audioTranscriptUpdates.push(entry.id)
        }
      } catch (e) {
        console.warn('Audio index reconcile failed:', e.message || e)
      }
    }
    if (audioTranscriptUpdates.length > 0) {
      try {
        window.dispatchEvent(new CustomEvent('yajna:audio-updated', { detail: { ids: audioTranscriptUpdates } }))
      } catch { /* ignore */ }
    }

    // Pull the currently-loaded day's journal — merge with local at the block
    // level so local edits that haven't flushed yet aren't lost.
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
      const visibleTasks = (Array.isArray(tasks) ? tasks : []).filter(t => !t.deleted)
      const visibleNotes = mergedNotes.filter(n => !n.deleted)
      const update = {
        tasks: visibleTasks,
        notes: visibleNotes,
        config: config || {},
      }
      if (updatedDay !== undefined) {
        update.currentDay = updatedDay
      }
      storeSetter(update)
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
      setStatus({ state: 'error', message: 'Session expired', isAuth: true })
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

async function getRemoteHash(ids) {
  const token = window.gapi?.client?.getToken()?.access_token
  if (!token) return { hash: null, journalFileId: null }

  const fileIds = [ids.tasksFileId, ids.notesFileId, ids.configFileId]
  if (ids.audioIndexFileId) fileIds.push(ids.audioIndexFileId)

  const journalFileId = await getJournalFileIdForCurrentDay(ids)
  if (journalFileId) fileIds.push(journalFileId)

  const times = await Promise.all(
    fileIds.map(async (fid) => {
      try {
        const res = await window.gapi.client.drive.files.get({
          fileId: fid,
          fields: 'modifiedTime',
        })
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
