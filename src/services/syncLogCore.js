/**
 * SW-SAFE core of the sync diagnostic ring buffer: just the IDB-backed append +
 * read. Split out of syncLog.js so it can be imported into the service worker
 * and sync-core WITHOUT dragging in drive.js (gapi/window) — the Drive-flush and
 * `window.*` debug helpers stay in syncLog.js (page-only).
 *
 * Persistent (IDB meta) so an intermittent bug can be inspected after the fact.
 * No `window`/`document`/`gapi`: safe to import into a worker. Temporary debug
 * aid — remove with syncLog.js once the audio-push migration is verified.
 */
import { getMeta, putMeta } from './db'

const LOG_KEY = 'sync_debug_log'
// Retain by time, not count: a dump should be "what happened recently" so the
// repro moment isn't buried under days of routine 1s-poll spam. MAX_ENTRIES is
// just a hard ceiling so a busy hour can't blow up memory/IDB.
const RETENTION_MS = 60 * 60 * 1000 // keep the last hour
const MAX_ENTRIES = 3000

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

// Drop anything older than the retention window. Entries are appended in time
// order, so the stale ones are always a prefix — find the first one we keep and
// splice everything before it in one shot. Runs on BOTH append and read, so a
// dump always returns a clean window even if logging has gone quiet (e.g. all
// call sites removed) and nothing has appended in hours. Returns true if it
// changed the buffer (so callers can decide whether to persist).
function prune() {
  const cutoff = Date.now() - RETENTION_MS
  let keepFrom = 0
  while (keepFrom < buffer.length && Date.parse(buffer[keepFrom].t) < cutoff) keepFrom++
  let changed = keepFrom > 0
  if (changed) buffer.splice(0, keepFrom)
  // Hard ceiling so a single busy hour can't grow unbounded.
  if (buffer.length > MAX_ENTRIES) { buffer.splice(0, buffer.length - MAX_ENTRIES); changed = true }
  return changed
}

export function logSync(event, data) {
  // Mirror to console for live watching too.
  console.debug(`[sync-debug] ${event}`, data || '')
  // Fire-and-forget IDB persistence.
  ;(async () => {
    await hydrate()
    buffer.push({ t: new Date().toISOString(), event, ...(data || {}) })
    prune()
    scheduleFlush()
  })()
}

export async function getSyncLog() {
  await hydrate()
  // Prune on read too: a stale buffer from before logging went quiet should
  // never bloat an export. Persist if it actually trimmed anything.
  if (prune()) scheduleFlush()
  return buffer.slice()
}

export async function clearSyncLog() {
  buffer = []
  hydrated = true
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await putMeta(LOG_KEY, [])
}
