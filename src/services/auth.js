import { AUTH_WORKER_URL } from '../lib/constants'
import { getMeta, putMeta } from './db'

const TOKEN_KEY = 'goog_token'
const REFRESH_BLOB_KEY = 'goog_refresh_blob'

let accessToken = null
let refreshTimer = null

/**
 * Load the GAPI client script
 */
export function loadGAPI() {
  return new Promise((resolve, reject) => {
    if (window.gapi?.client) return resolve()
    const script = document.createElement('script')
    script.src = 'https://apis.google.com/js/api.js'
    script.onload = () => {
      window.gapi.load('client', {
        callback: resolve,
        onerror: reject,
      })
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
}

export async function initGAPI() {
  await window.gapi.client.init({
    discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
  })
}

/**
 * Returns a stored token from IndexedDB if still valid
 */
export async function getStoredToken() {
  try {
    const stored = await getMeta(TOKEN_KEY)
    if (!stored) return null
    if (stored.expiresAt && Date.now() < stored.expiresAt - 60_000) {
      return stored.token
    }
  } catch {}
  return null
}

export async function storeToken(token, expiresInSeconds) {
  await putMeta(TOKEN_KEY, {
    token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  })
}

export async function clearStoredToken() {
  await putMeta(TOKEN_KEY, null)
}

export async function storeRefreshBlob(blob) {
  if (blob) {
    await putMeta(REFRESH_BLOB_KEY, blob)
  }
}

export async function getRefreshBlob() {
  return await getMeta(REFRESH_BLOB_KEY)
}

export async function clearRefreshBlob() {
  await putMeta(REFRESH_BLOB_KEY, null)
}

export async function getTokenRemainingSeconds() {
  try {
    const stored = await getMeta(TOKEN_KEY)
    if (!stored?.expiresAt) return 0
    return Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000))
  } catch {
    return 0
  }
}

/**
 * Redirect the whole tab to the Worker's login endpoint.
 * Worker handles PKCE and redirects to Google.
 */
export function startAuthRedirect() {
  const redirect = encodeURIComponent(window.location.origin + window.location.pathname)
  window.location.assign(`${AUTH_WORKER_URL}/login?redirect=${redirect}`)
}

let silentRefreshInFlight = null

/**
 * Try to renew the access token silently via the Worker's /refresh endpoint.
 * Returns { token, expiresIn } on success, or null on auth failure (401).
 * Throws on network/server error so the caller can distinguish and retry.
 *
 * Coalesced: Google rotates the refresh token on use, so two concurrent
 * /refresh calls would replay the same (now-consumed) token and the loser
 * gets a 401 that triggers signOut(). This happens on wake-from-sleep when
 * the visibility handler and the sync poll both fire at once. All callers
 * share a single in-flight request so the blob is only ever rotated once.
 */
export async function trySilentRefresh() {
  if (silentRefreshInFlight) return silentRefreshInFlight
  silentRefreshInFlight = (async () => {
    const refresh_blob = await getRefreshBlob()
    if (!refresh_blob) return null

    const res = await fetch(`${AUTH_WORKER_URL}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_blob }),
    })

    if (!res.ok) {
      if (res.status === 401) {
        await signOut() // Refresh token revoked or invalid
        return null
      }
      throw new Error(`Refresh failed: ${res.status}`)
    }

    const data = await res.json()
    await storeRefreshBlob(data.refresh_blob) // Persist rotated blob
    return { token: data.access_token, expiresIn: data.expires_in }
  })()
  try {
    return await silentRefreshInFlight
  } finally {
    silentRefreshInFlight = null
  }
}

/**
 * Schedule a silent token refresh 5 minutes before the token expires.
 * Calls onExpired() if silent refresh fails permanently (401).
 * If it fails due to network, it will keep retrying every 30s.
 */
export function scheduleTokenRefresh(expiresInSeconds, onExpired) {
  if (refreshTimer) clearTimeout(refreshTimer)
  // Refresh 5 minutes before expiry, minimum 30 seconds from now
  const refreshIn = Math.max((expiresInSeconds - 300) * 1000, 30_000)
  refreshTimer = setTimeout(async () => {
    try {
      const result = await trySilentRefresh()
      if (result) {
        setAccessToken(result.token)
        await storeToken(result.token, result.expiresIn)
        scheduleTokenRefresh(result.expiresIn, onExpired)
      } else if (onExpired) {
        // null means 401 or no refresh blob — permanent failure
        onExpired()
      }
    } catch (err) {
      console.warn('Silent refresh network error, retrying in 30s:', err)
      // Network error — retry in 30s indefinitely until success or 401
      scheduleTokenRefresh(330, onExpired) // 330s total means retry in 30s (330-300=30)
    }
  }, refreshIn)
}

/**
 * If the current URL contains an OAuth redirect response from the Worker,
 * extract the token and refresh blob, strip the fragment, and return them.
 */
export function consumeAuthRedirect() {
  const hash = window.location.hash
  if (!hash) return null
  
  if (!hash.includes('access_token=') && !hash.includes('refresh_blob=')) return null

  const params = new URLSearchParams(hash.slice(1))
  const token = params.get('access_token')
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10)
  const refreshBlob = params.get('refresh_blob')

  // Strip the fragment so HashRouter sees a clean URL
  history.replaceState(null, '', window.location.pathname + window.location.search)

  if (!token) return null
  return { token, expiresIn, refreshBlob }
}

export function getAccessToken() {
  return accessToken
}

export function setAccessToken(token) {
  accessToken = token
  if (window.gapi?.client) {
    window.gapi.client.setToken({ access_token: token })
  }
}

/**
 * Page token provider for sync-core (see sync-core/tokenProvider.js for the
 * contract). Prefers the live in-memory token (set on login / refresh and
 * mirrored into gapi), falling back to the persisted IDB token — so on the page
 * a push pays no extra IDB read on the hot path. refresh() reuses the page's
 * coalesced refreshOnce so a SW-bound push and a page poll don't double-rotate
 * the refresh blob. This is what audio.js / future CRDT pushes inject when
 * running ON the page; the SW injects headlessTokenProvider instead.
 */
export const pageTokenProvider = {
  async getToken() {
    return accessToken || (await getStoredToken())
  },
  async refresh() {
    return refreshOnce()
  },
}

export async function signOut() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (accessToken) {
    // Best-effort revoke; don't block on it
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    } catch {}
  }
  accessToken = null
  await clearStoredToken()
  await clearRefreshBlob()
}

/**
 * Check if an error is an authentication failure (401 or 403)
 */
export function isAuthError(e) {
  const code = e?.status || e?.result?.error?.code
  return code === 401 || code === 403
}

let refreshInFlight = null
let lastAuthFailureAt = 0

/**
 * Coalesced silent refresh. If a refresh is already running, the second caller
 * awaits the same promise instead of stacking parallel /refresh requests
 * against the worker.
 */
async function refreshOnce() {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const refreshed = await trySilentRefresh()
      if (!refreshed) return false
      await storeToken(refreshed.token, refreshed.expiresIn)
      setAccessToken(refreshed.token)
      return true
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * Run `fn`; on a 401/403, refresh the token once and retry. If the refresh
 * fails (no refresh blob, worker rejected it, or the retry still 401/403s),
 * the original error is rethrown so callers can surface "session expired".
 *
 * A short cooldown after a failed refresh prevents tight loops when every
 * pending Drive call hits the same expired token in parallel.
 */
export async function withAuthRetry(fn) {
  try {
    return await fn()
  } catch (e) {
    if (!isAuthError(e)) throw e
    // Throttle: if we just gave up on a refresh, don't keep trying for 60s.
    if (Date.now() - lastAuthFailureAt < 60_000) throw e
    let refreshed = false
    try {
      refreshed = await refreshOnce()
    } catch (refreshErr) {
      // Network / server error from the worker. Surface the original auth error
      // since callers care about "is this auth-broken" not "is the worker down".
      console.warn('withAuthRetry: silent refresh failed', refreshErr)
    }
    if (!refreshed) {
      lastAuthFailureAt = Date.now()
      throw e
    }
    return await fn()
  }
}
