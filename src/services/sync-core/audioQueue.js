/**
 * sync-core: the durable hand-off between the page and the service worker for
 * audio uploads (see project_sw_push_migration, step 3).
 *
 * Why a queue (and why in IDB): the SW that fires on a Background Sync `sync`
 * event is a fresh, page-less context — it shares NO memory with the tab that
 * recorded the clip. The only thing they both can see is IndexedDB. So the page
 * records the *intent* ("upload audio id X") here, registers a sync tag, and the
 * SW later reads the same row and drains it. It is also what makes the upload
 * survive screen-off: the intent is persisted before the page is frozen, and the
 * SW is woken to finish the job.
 *
 * Storage shape: a single `meta` row keyed `audio_push_queue` holding an array
 * of ids. We reuse the existing `meta` store rather than add an object store so
 * there is NO DB_VERSION bump / migration during the active multi-device sync
 * work — a new store would force an `upgrade` on every device. Reads/writes go
 * through getMeta/putMeta, which both the page and the SW can call.
 *
 * Concurrency note: the read-modify-write below is NOT transactional, so two
 * simultaneous enqueues could in principle race. In practice enqueues are driven
 * by user actions (one recording finishing at a time) on a single context, and
 * the SW drains under its own `sync` event. ids are de-duplicated on enqueue and
 * removed by value on success, so a lost-update at worst re-runs an idempotent
 * upload (pushAudioWith short-circuits an already-uploaded id) — never data loss.
 * No `window`/`document`/`gapi`: safe to import into a worker.
 */
import { getMeta, putMeta } from '../db'

const QUEUE_KEY = 'audio_push_queue'

async function readQueue() {
  const q = await getMeta(QUEUE_KEY)
  return Array.isArray(q) ? q : []
}

/** Add an audio id to the pending-upload queue (no-op if already present). */
export async function enqueueAudioPush(id) {
  if (!id) return
  const q = await readQueue()
  if (q.includes(id)) return
  q.push(id)
  await putMeta(QUEUE_KEY, q)
}

/** Snapshot the pending ids (does not mutate). */
export async function peekAudioQueue() {
  return readQueue()
}

/** Remove an id from the queue after a successful (or no-op) upload. */
export async function dequeueAudioPush(id) {
  const q = await readQueue()
  const next = q.filter((x) => x !== id)
  if (next.length !== q.length) await putMeta(QUEUE_KEY, next)
}
