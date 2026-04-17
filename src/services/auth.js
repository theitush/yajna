import { GOOGLE_CLIENT_ID, SCOPES } from '../lib/constants'
import { getMeta, putMeta } from './db'

const TOKEN_KEY = 'goog_token'
const AUTH_STATE_KEY = 'goog_auth_state'

let accessToken = null
let refreshTimer = null
let gisTokenClient = null

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
 * Load Google Identity Services. Used for silent token renewal —
 * GIS handles Google's cookie/FedCM quirks better than a raw OAuth iframe.
 */
export function loadGIS() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve()
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = reject
    document.head.appendChild(script)
  })
}

/**
 * Try to renew the access token silently via GIS. Returns
 * { token, expiresIn } on success, or null on any failure.
 * GIS with prompt: '' uses Google's session cookies without a popup —
 * works on Firefox when the user is actively signed in to Google.
 */
export async function trySilentRefreshGIS() {
  try {
    await loadGIS()
  } catch {
    return null
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10_000)
    try {
      if (!gisTokenClient) {
        gisTokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          prompt: '',
          callback: () => {}, // overwritten per call below
          error_callback: () => {},
        })
      }
      gisTokenClient.callback = (resp) => {
        clearTimeout(timeout)
        if (resp?.access_token) {
          const expiresIn = parseInt(resp.expires_in || '3600', 10)
          resolve({ token: resp.access_token, expiresIn })
        } else {
          resolve(null)
        }
      }
      gisTokenClient.error_callback = () => {
        clearTimeout(timeout)
        resolve(null)
      }
      gisTokenClient.requestAccessToken({ prompt: '' })
    } catch {
      clearTimeout(timeout)
      resolve(null)
    }
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

export async function getTokenRemainingSeconds() {
  try {
    const stored = await getMeta(TOKEN_KEY)
    if (!stored?.expiresAt) return 0
    return Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000))
  } catch {
    return 0
  }
}

function getRedirectUri() {
  // Strip hash and query so the redirect_uri is deterministic and matches
  // what we register in the Google Cloud Console.
  return window.location.origin + window.location.pathname
}

function randomState() {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Redirect the whole tab to Google's OAuth endpoint (implicit flow).
 * On successful auth Google redirects back to redirect_uri with the access
 * token in the URL fragment. This avoids the popup/COOP issues that break
 * the GIS popup flow on cross-origin hosts like GitHub Pages.
 */
export async function startAuthRedirect() {
  const state = randomState()
  sessionStorage.setItem(AUTH_STATE_KEY, state)
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state,
  })
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}

/**
 * Try to renew the access token silently. Prefers GIS (works on Firefox
 * with ETP when the user is signed in to Google); falls back to a hidden
 * OAuth iframe if GIS fails.
 */
export async function trySilentRefresh() {
  const viaGIS = await trySilentRefreshGIS()
  if (viaGIS) return viaGIS
  return trySilentRefreshIframe()
}

/**
 * Fallback: hidden iframe with prompt=none. Often blocked by Firefox ETP,
 * but works as a last resort on browsers that allow third-party cookies.
 */
function trySilentRefreshIframe() {
  return new Promise((resolve) => {
    const state = randomState()
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: getRedirectUri(),
      response_type: 'token',
      scope: SCOPES,
      include_granted_scopes: 'true',
      state,
      prompt: 'none',
    })

    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'

    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, 10_000)

    function cleanup() {
      clearTimeout(timeout)
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
    }

    // Listen for the iframe to load and check its URL for the token
    iframe.addEventListener('load', () => {
      try {
        const hash = iframe.contentWindow.location.hash
        if (!hash || !hash.includes('access_token=')) {
          cleanup()
          resolve(null)
          return
        }
        const fragParams = new URLSearchParams(hash.slice(1))
        const token = fragParams.get('access_token')
        const expiresIn = parseInt(fragParams.get('expires_in') || '3600', 10)
        const returnedState = fragParams.get('state')
        cleanup()
        if (!token || returnedState !== state) {
          resolve(null)
          return
        }
        resolve({ token, expiresIn })
      } catch {
        // Cross-origin error means Google showed a login page — silent auth failed
        cleanup()
        resolve(null)
      }
    })

    document.body.appendChild(iframe)
    iframe.src = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  })
}

/**
 * Schedule a silent token refresh 5 minutes before the token expires.
 * Calls onExpired() if silent refresh fails so the app can re-prompt login.
 */
export function scheduleTokenRefresh(expiresInSeconds, onExpired) {
  if (refreshTimer) clearTimeout(refreshTimer)
  // Refresh 5 minutes before expiry, minimum 30 seconds from now
  const refreshIn = Math.max((expiresInSeconds - 300) * 1000, 30_000)
  refreshTimer = setTimeout(async () => {
    const result = await trySilentRefresh()
    if (result) {
      setAccessToken(result.token)
      await storeToken(result.token, result.expiresIn)
      scheduleTokenRefresh(result.expiresIn, onExpired)
    } else if (onExpired) {
      onExpired()
    }
  }, refreshIn)
}

/**
 * If the current URL contains an OAuth redirect response, extract the token,
 * validate state, strip the hash, and return the token. Otherwise return null.
 * Must run before HashRouter reads the URL, because the OAuth response uses
 * the fragment.
 */
export function consumeAuthRedirect() {
  const hash = window.location.hash
  if (!hash) return null
  // If Google returned an error (e.g. access_denied), strip the fragment
  // so HashRouter doesn't try to match it as a route.
  if (hash.includes('error=')) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return null
  }
  if (!hash.includes('access_token=')) return null
  // The hash looks like "#access_token=...&expires_in=...&state=..."
  const params = new URLSearchParams(hash.slice(1))
  const token = params.get('access_token')
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10)
  const state = params.get('state')
  const expected = sessionStorage.getItem(AUTH_STATE_KEY)
  sessionStorage.removeItem(AUTH_STATE_KEY)
  // Strip the OAuth fragment so HashRouter sees a clean URL
  history.replaceState(null, '', window.location.pathname + window.location.search)
  if (!token) return null
  if (!expected || state !== expected) {
    console.warn('OAuth state mismatch — ignoring redirect response')
    return null
  }
  return { token, expiresIn }
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
}
