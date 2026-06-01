/**
 * yajna service worker (project_sw_push_migration, step 3).
 *
 * Its ONE job today: finish audio uploads after the page is frozen/closed. On
 * Android Chrome a Background Sync `sync` event wakes this worker even when the
 * tab is gone, so a clip recorded right before the screen turns off still
 * reaches Drive. We do NOT precache the app or intercept fetch — this is a
 * push-only worker; the page stays in charge of pulling and rendering.
 *
 * Built with vite-plugin-pwa in injectManifest mode, so this file is the whole
 * SW (no workbox routing). We don't precache, but the plugin still requires the
 * manifest symbol to be referenced; we touch it and move on.
 *
 * The actual upload runs through sync-core (drainAudioQueue → pushAudioWith →
 * headlessTokenProvider), the same gapi-free pipeline the page uses, so there is
 * exactly one upload implementation. The token comes from IndexedDB (shared with
 * the page) and refreshes itself headlessly via the auth worker.
 */
import { drainAudioQueue } from '../services/sync-core/drainAudioQueue'
import { headlessTokenProvider } from '../services/sync-core/tokenProvider'

// Required reference for injectManifest (we intentionally precache nothing).
const _manifest = self.__WB_MANIFEST
void _manifest

const AUDIO_SYNC_TAG = 'push-audio'

/**
 * Tell any open tabs that a clip uploaded, so the page can stamp the resulting
 * driveFileId onto its document node (the self-sufficient reference). Best
 * effort: if no tab is open the stamp simply happens on the next device pull,
 * where ensureAudioLocal resolves the blob from IDB / audio-meta anyway.
 */
async function notifyUploaded(results) {
  if (!results?.length) return
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const client of clients) {
    for (const r of results) client.postMessage({ type: 'audio-uploaded', ...r })
  }
}

function drainAndNotify() {
  return drainAudioQueue(headlessTokenProvider, notifyUploaded)
}

// Activate immediately so the first registration can start handling sync events
// without waiting for all tabs to close.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/**
 * Background Sync: fired (possibly long) after the page queued an upload, even
 * if the tab is closed. A rejected waitUntil tells the platform the work isn't
 * done and to retry the tag later — drainAudioQueue rethrows on any failure for
 * exactly this reason, leaving failed ids in the IDB queue.
 */
self.addEventListener('sync', (event) => {
  if (event.tag === AUDIO_SYNC_TAG) {
    event.waitUntil(drainAndNotify())
  }
})

/**
 * Immediate nudge from the page (e.g. right after enqueue, while still
 * foreground) so the upload starts without waiting for the platform to schedule
 * the sync event. Best-effort; the `sync` event is the durable path.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'drain-audio') {
    event.waitUntil(drainAndNotify().catch(() => {}))
  }
})
