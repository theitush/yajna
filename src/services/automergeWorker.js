/**
 * Automerge worker — runs the synchronous Automerge WASM (load/change/merge/
 * save) OFF the main thread.
 *
 * Why: Automerge.load/save/merge/change are synchronous CPU on the calling
 * thread. The journal push fires them on every save; on a multi-KB doc each call
 * is long enough to freeze the editor — the typing lag. Debounce/coalescing only
 * delay the freeze (a single push still blocks). Moving the work into a worker is
 * the only real cure: the UI thread never stalls, regardless of doc size.
 *
 * Boundary: bytes-in / bytes-out. Automerge doc objects never cross postMessage
 * (they can't be cloned); the worker takes byte snapshots + a plain source row,
 * runs the whole load→apply/merge→save chain, and returns merged bytes + the
 * materialized plain row. The op bodies live in ./automergeInline so the worker
 * and the main-thread fallback share ONE implementation of the merge rules.
 *
 * Loaded as a module worker (Vite `new Worker(new URL(...), { type: 'module' })`).
 */
import { journalApply, journalMerge } from './automergeInline'

const HANDLERS = { journalApply, journalMerge }

self.onmessage = async (e) => {
  const { id, op, payload } = e.data || {}
  const handler = HANDLERS[op]
  if (!handler) {
    self.postMessage({ id, error: `automergeWorker: unknown op "${op}"` })
    return
  }
  try {
    const result = await handler(payload)
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) })
  }
}
