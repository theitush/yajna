/**
 * sync-core: drain the pending audio-upload queue (see project_sw_push_migration).
 *
 * This is the unit of work both the service worker (on a `sync` event) and the
 * page (as a fallback / on reconnect) run. It walks the queued ids, uploads each
 * via the portable pushAudioWith pipeline, and removes the id once the upload
 * succeeds (or no-ops because the clip was already pushed). It is deliberately
 * provider-injected so the SW passes headlessTokenProvider and the page can pass
 * pageTokenProvider — the upload logic stays in exactly one place.
 *
 * Failure handling: an id that throws is LEFT in the queue so the next `sync`
 * retry (Background Sync re-fires on failure) or the next page reconnect picks
 * it up. We rethrow after the loop if anything failed, because the SW relies on
 * a rejected waitUntil to tell the platform "not done, retry me". A 401 with no
 * usable refresh blob (logged-out) bubbles up the same way — harmless, the retry
 * will keep failing quietly until the user is signed in again.
 *
 * No `window`/`document`/`gapi`: safe to import into a worker.
 */
import { peekAudioQueue, dequeueAudioPush } from './audioQueue'
import { pushAudioWith } from './pushAudioCore'
import { logSync } from '../syncLogCore'

/**
 * @param provider  token provider (headless in SW, page provider as fallback)
 * @param onResults optional async hook called with [{ id, driveFileId }] for the
 *                  clips that actually uploaded this run, so the caller (page or
 *                  SW) can stamp the driveFileId back onto the document node.
 */
export async function drainAudioQueue(provider, onResults = null) {
  const ids = await peekAudioQueue()
  logSync('audio drain: start', { queued: ids.length, ids })
  if (!ids.length) return { uploaded: 0, failed: 0 }

  let uploaded = 0
  let failed = 0
  let firstError = null
  const results = []

  for (const id of ids) {
    try {
      const driveFileId = await pushAudioWith(provider, id)
      // Success OR a legitimate no-op (no blob / already uploaded): the id is
      // done either way — drop it so we don't spin on it forever.
      await dequeueAudioPush(id)
      uploaded++
      if (driveFileId) results.push({ id, driveFileId })
      logSync('audio drain: pushed', { id, driveFileId: driveFileId || null })
    } catch (e) {
      failed++
      if (!firstError) firstError = e
      logSync('audio drain: push FAILED (left queued)', { id, err: e?.message || String(e), status: e?.status })
      // Leave the id queued for the next retry.
    }
  }

  if (results.length && typeof onResults === 'function') {
    try { await onResults(results) } catch { /* notify is best-effort */ }
  }
  if (firstError) throw firstError
  return { uploaded, failed }
}
