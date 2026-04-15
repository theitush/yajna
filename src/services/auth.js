import { GOOGLE_CLIENT_ID, SCOPES } from '../lib/constants'
import { getMeta, putMeta } from './db'

const TOKEN_KEY = 'goog_token'
const AUTH_STATE_KEY = 'goog_auth_state'

let accessToken = null

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
    prompt: 'consent',
  })
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}

/**
 * If the current URL contains an OAuth redirect response, extract the token,
 * validate state, strip the hash, and return the token. Otherwise return null.
 * Must run before HashRouter reads the URL, because the OAuth response uses
 * the fragment.
 */
export function consumeAuthRedirect() {
  const hash = window.location.hash
  if (!hash || !hash.includes('access_token=')) return null
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
