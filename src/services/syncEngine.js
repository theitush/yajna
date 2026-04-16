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
import { getTasks, getNotes, getConfig, putTasks, putNotes, putConfig, putJournal } from './db'
import { getStoredToken } from './auth'

const DEFAULT_POLL_INTERVAL = 1000  // 1 second default
const RETRY_BASE_MS = 2000         // retry backoff starts at 2s
const RETRY_MAX_MS = 30000         // max retry backoff 30s

let pollIntervalMs = DEFAULT_POLL_INTERVAL

let pollTimer = null
let retryTimer = null
let countdownTimer = null
let retryCount = 0
let listeners = new Set()
let status = { state: 'synced' }
let running = false
let pendingPush = null
let lastRemoteHash = null
let _storeSetter = null
let _storeGetter = null

function setStatus(s) {
  // Deep compare for waiting state
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

/**
 * Start the sync engine. Call after initial sync is done.
 */
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

  if (!navigator.onLine) {
    setStatus({ state: 'offline' })
  } else {
    setStatus({ state: 'synced' })
    startPolling(storeSetter)
  }
}

/**
 * Stop the sync engine.
 */
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
  setStatus({ state: 'offline' })
}

/**
 * Manually trigger a retry now (called when user clicks the status).
 */
export function retryNow() {
  if (!running) return
  clearTimeout(retryTimer)
  clearInterval(countdownTimer)
  retryTimer = null
  countdownTimer = null

  if (pendingPush) {
    setStatus({ state: 'syncing' })
    const fn = pendingPush
    pendingPush = null
    executePush(fn)
  } else {
    // Just force a poll
    setStatus({ state: 'syncing' })
    pollRemote(_storeSetter).then(() => {
      if (status.state === 'syncing') setStatus({ state: 'synced' })
    })
  }
}

// --- Internal ---

function handleOnline() {
  if (!running) return
  retryCount = 0
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

/**
 * Update the poll interval while the engine is running.
 */
export function setPollInterval(ms) {
  pollIntervalMs = ms || DEFAULT_POLL_INTERVAL
  if (running && pollTimer) {
    startPolling(_storeSetter)
  }
}

async function pollRemote(storeSetter) {
  if (!running || !navigator.onLine) return

  try {
    const token = await getStoredToken()
    if (!token) return

    const ids = await getDriveFileIds()
    if (!ids) return

    const hash = await getRemoteHash(ids)
    if (hash === lastRemoteHash) return

    setStatus({ state: 'syncing' })

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

    // Pull the current journal week if one is loaded
    let updatedJournal = undefined
    if (ids.journalsFolderId && _storeGetter) {
      const currentJournal = _storeGetter()?.currentJournal
      if (currentJournal?.week) {
        const filename = `${currentJournal.week}.json`
        const fileId = await findFile(ids.journalsFolderId, filename)
        if (fileId) {
          const doc = await readJsonFile(fileId)
          if (doc) {
            await putJournal(doc)
            updatedJournal = doc
          }
        }
      }
    }

    if (storeSetter) {
      const update = {
        tasks: Array.isArray(tasks) ? tasks : [],
        notes: Array.isArray(notes) ? notes : [],
        config: config || {},
      }
      if (updatedJournal !== undefined) {
        update.currentJournal = updatedJournal
      }
      storeSetter(update)
    }

    lastRemoteHash = hash
    setStatus({ state: 'synced' })
  } catch (e) {
    console.warn('Poll failed:', e.message || e)
    if (!navigator.onLine) {
      setStatus({ state: 'offline' })
    }
  }
}

async function getRemoteHash(ids) {
  const token = window.gapi?.client?.getToken()?.access_token
  if (!token) return null

  const fileIds = [ids.tasksFileId, ids.notesFileId, ids.configFileId]
  // Include journals folder — its modifiedTime changes when any journal file is added/updated
  if (ids.journalsFolderId) fileIds.push(ids.journalsFolderId)
  const times = await Promise.all(
    fileIds.map(async (fid) => {
      try {
        const res = await window.gapi.client.drive.files.get({
          fileId: fid,
          fields: 'modifiedTime',
        })
        return res.result.modifiedTime
      } catch {
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

  const delayMs = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_MAX_MS)
  retryCount++
  let remaining = Math.ceil(delayMs / 1000)
  setStatus({ state: 'waiting', retryIn: remaining })

  // Countdown every second
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
  // Don't attempt push if offline — go straight to queuing
  if (!navigator.onLine) {
    scheduleRetry(pushFn)
    return
  }
  setStatus({ state: 'syncing' })
  try {
    await pushFn()
    retryCount = 0
    pendingPush = null
    setStatus({ state: 'synced' })
    // Update hash so our own write doesn't trigger re-pull
    try {
      const ids = await getDriveFileIds()
      if (ids) lastRemoteHash = await getRemoteHash(ids)
    } catch {}
  } catch (e) {
    console.warn('Push failed:', e.message || e)
    scheduleRetry(pushFn)
  }
}

/**
 * Wrap a push operation with error handling and retry.
 */
export function withRetry(pushFn) {
  return () => executePush(pushFn)
}
