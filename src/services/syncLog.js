/**
 * Persistent ring buffer for sync diagnostics. Survives page reloads (stored in
 * IDB meta) so an intermittent cross-device staleness bug can be inspected after
 * the fact instead of requiring someone to watch the console at the exact moment.
 *
 * Workflow when staleness happens:
 *   1. reproduce / notice it
 *   2. in the console run:  await window.dumpSyncLog()
 *   3. paste the output
 *
 * This is a temporary debug aid — remove once the staleness root cause is fixed.
 */
import { getMeta, putMeta } from './db'

const LOG_KEY = 'sync_debug_log'
const MAX_ENTRIES = 300

// In-memory mirror so rapid 1s-poll appends don't serialize a full IDB
// read-modify-write each time. Hydrated lazily from IDB on first use.
let buffer = null
let hydrated = false
let flushTimer = null

async function hydrate() {
  if (hydrated) return
  try {
    const stored = await getMeta(LOG_KEY)
    buffer = Array.isArray(stored) ? stored : []
  } catch {
    buffer = []
  }
  hydrated = true
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = null
    try {
      await putMeta(LOG_KEY, buffer)
    } catch { /* best-effort — it's a debug log */ }
  }, 1000)
}

export function logSync(event, data) {
  // Mirror to console for live watching too.
  console.debug(`[sync-debug] ${event}`, data || '')
  // Fire-and-forget IDB persistence.
  ;(async () => {
    await hydrate()
    buffer.push({ t: new Date().toISOString(), event, ...(data || {}) })
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
    scheduleFlush()
  })()
}

export async function getSyncLog() {
  await hydrate()
  return buffer.slice()
}

export async function clearSyncLog() {
  buffer = []
  hydrated = true
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await putMeta(LOG_KEY, [])
}

if (typeof window !== 'undefined') {
  window.dumpSyncLog = async () => {
    const log = await getSyncLog()
    console.log(JSON.stringify(log, null, 2))
    return log
  }
  window.clearSyncLog = clearSyncLog
}
