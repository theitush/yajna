/**
 * Client for automergeWorker — a tiny postMessage RPC so the main thread can run
 * the journal Automerge ops off-thread without ever blocking the editor.
 *
 * The worker is created lazily on first use (so it doesn't cost cold-boot time)
 * and reused. Each call gets a monotonic id; we resolve the matching promise when
 * the worker replies. If the worker can't be constructed (old browser, blocked
 * context), we fall back to running the same ops inline on the main thread —
 * correctness is identical, only the lag returns. Better degraded than broken.
 */
import { logSync } from './syncLog'

let worker = null
let workerBroken = false
let nextId = 1
const pending = new Map()

function getWorker() {
  if (worker || workerBroken) return worker
  try {
    worker = new Worker(new URL('./automergeWorker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const { id, result, error } = e.data || {}
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (error) entry.reject(new Error(error))
      else entry.resolve(result)
    }
    worker.onerror = (e) => {
      // A fatal worker error rejects everything in flight and disables the
      // worker so subsequent calls take the inline fallback.
      logSync('automerge worker error → inline fallback', { msg: e?.message || String(e) })
      workerBroken = true
      for (const [, entry] of pending) entry.reject(new Error('automerge worker crashed'))
      pending.clear()
      try { worker.terminate() } catch { /* ignore */ }
      worker = null
    }
  } catch (e) {
    logSync('automerge worker unavailable → inline fallback', { msg: e?.message || String(e) })
    workerBroken = true
    worker = null
  }
  return worker
}

function call(op, payload) {
  const w = getWorker()
  if (!w) return inlineFallback(op, payload)
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    w.postMessage({ id, op, payload })
  }).catch(async (err) => {
    // If the worker died mid-call, retry once inline so the user's edit isn't
    // lost — the op is pure and idempotent on its byte inputs.
    if (workerBroken) return inlineFallback(op, payload)
    throw err
  })
}

// Inline fallback: import the worker module's logic on the main thread. The
// worker file's handlers aren't exported (it's a worker entry), so we re-run the
// equivalent via the shared automergeDoc helpers. Kept in lockstep with the
// worker by importing the SAME helpers — there's no second copy of merge rules.
async function inlineFallback(op, payload) {
  const m = await import('./automergeInline')
  return m[op](payload)
}

export function journalApply(payload) {
  return call('journalApply', payload)
}

export function journalMerge(payload) {
  return call('journalMerge', payload)
}
