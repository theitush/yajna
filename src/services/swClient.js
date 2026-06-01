/**
 * Page-side service-worker client (project_sw_push_migration, step 3).
 *
 * This is the WINDOW side of the audio-push hand-off: it registers the SW,
 * enqueues an upload intent in IDB, and asks the platform to wake the SW to
 * finish it (Background Sync). It is the only file here that touches
 * `navigator.serviceWorker` / `SyncManager`, keeping the SW and sync-core
 * window-free.
 *
 * The non-regression contract (see project_sw_push_migration): Background Sync
 * exists only on Chromium. On desktop Firefox (the dev/test browser) and iOS
 * Safari there is no SyncManager, so we MUST NOT drop the upload — we fall back
 * to uploading directly on the page via the same sync-core pipeline. Android
 * Chrome gets the screen-off win; everyone else keeps today's behavior. Either
 * way the id is enqueued first, so a direct upload that fails (offline) still
 * leaves a durable intent for a later drain.
 */
import { enqueueAudioPush } from './sync-core/audioQueue'
import { drainAudioQueue } from './sync-core/drainAudioQueue'
import { pageTokenProvider } from './auth'

const SW_URL = `${import.meta.env.BASE_URL}sw.js`
const SW_SCOPE = import.meta.env.BASE_URL
const AUDIO_SYNC_TAG = 'push-audio'

let registrationPromise = null
let messageListenerAttached = false

// Per-id "stamp the driveFileId onto the node" callbacks, registered by the
// recorder before it queues a clip. Fired when the SW (or the fallback drain)
// reports the upload finished. One-shot per id.
const uploadStampCallbacks = new Map()

function swSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

function applyUploadResult({ id, driveFileId }) {
  if (!id || !driveFileId) return
  const cb = uploadStampCallbacks.get(id)
  if (cb) {
    uploadStampCallbacks.delete(id)
    try { cb(driveFileId) } catch (e) { console.warn('[sw] stamp callback failed', e) }
  }
}

function attachMessageListener() {
  if (messageListenerAttached || !swSupported()) return
  messageListenerAttached = true
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'audio-uploaded') applyUploadResult(event.data)
  })
}

/** Register the SW once. Returns the registration, or null if unsupported. */
export function registerServiceWorker() {
  if (!swSupported()) return Promise.resolve(null)
  if (!registrationPromise) {
    attachMessageListener()
    registrationPromise = navigator.serviceWorker
      .register(SW_URL, { scope: SW_SCOPE, type: 'module' })
      .catch((e) => {
        console.warn('[sw] registration failed', e)
        registrationPromise = null
        return null
      })
  }
  return registrationPromise
}

/**
 * Queue an audio id for upload and get it pushed out as resiliently as the
 * platform allows:
 *   - Always persist the intent in IDB first (survives screen-off / reload).
 *   - If Background Sync is available, register the tag so the SW finishes the
 *     job even if the page is frozen, and nudge the active SW to start now.
 *   - Otherwise (Firefox/iOS/no SW), upload directly on the page — same core.
 * Never throws; a failed direct upload just leaves the id queued for next time.
 *
 * @param onUploaded optional (driveFileId) => void, fired once when this clip
 *   uploads — used to stamp the id onto the document node. On the SW path it
 *   arrives via postMessage; on the fallback path it's invoked inline. If the
 *   page is gone before the SW finishes, the stamp is skipped and the next
 *   device pull resolves the blob from IDB / audio-meta instead.
 */
export async function queueAudioPush(id, onUploaded = null) {
  if (!id) return
  if (typeof onUploaded === 'function') uploadStampCallbacks.set(id, onUploaded)
  await enqueueAudioPush(id)

  const reg = await registerServiceWorker()
  const canBackgroundSync = !!reg && 'sync' in reg

  if (canBackgroundSync) {
    try {
      await reg.sync.register(AUDIO_SYNC_TAG)
      // Nudge the controlling SW to drain immediately while we're foreground;
      // the registered sync tag is the durable fallback if this no-ops.
      navigator.serviceWorker.controller?.postMessage({ type: 'drain-audio' })
      return
    } catch (e) {
      console.warn('[sw] sync.register failed, uploading on page', e)
      // fall through to direct upload
    }
  }

  // Fallback path (no Background Sync, or registration failed): upload here,
  // stamping inline via the same per-id callback the SW path uses.
  try {
    await drainAudioQueue(pageTokenProvider, (results) => results.forEach(applyUploadResult))
  } catch (e) {
    console.warn('[sw] direct audio drain failed (queued for retry)', e)
  }
}
