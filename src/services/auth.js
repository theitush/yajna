import { GOOGLE_CLIENT_ID, SCOPES } from '../lib/constants'
import { getMeta, putMeta } from './db'

const TOKEN_KEY = 'goog_token'

let tokenClient = null
let accessToken = null

/**
 * Load the Google Identity Services script dynamically
 */
export function loadGIS() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts) return resolve()
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
}

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

/**
 * Initiate OAuth token request. Returns a promise that resolves with the access token.
 * @param {boolean} selectAccount - If true, always show account chooser (use for manual sign-in)
 */
export function requestToken(selectAccount = false) {
  return new Promise((resolve, reject) => {
    // Always create a fresh client so the callback captures the current promise's resolve/reject
    let settled = false
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          settled = true
          return reject(new Error(response.error))
        }
        settled = true
        accessToken = response.access_token
        storeToken(response.access_token, response.expires_in)
          .then(() => resolve(response.access_token))
          .catch(() => resolve(response.access_token))
      },
      error_callback: (err) => {
        if (settled) return
        const type = err?.type || 'token_request_failed'
        // GIS fires popup_closed before the OAuth response arrives when 2FA is
        // involved. Wait a tick to see if the success callback fires first.
        if (type === 'popup_closed') {
          setTimeout(() => {
            if (settled) return
            tokenClient = null
            reject(new Error(type))
          }, 3000)
        } else {
          tokenClient = null
          reject(new Error(type))
        }
      },
    })
    // Use 'select_account' for manual sign-in so Google shows the account picker
    // and doesn't silently retry via setTimeout loops when the popup is closed.
    // Use '' (empty) only for silent token refresh where we know the account.
    tokenClient.requestAccessToken({ prompt: selectAccount ? 'select_account' : '' })
  })
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

export function signOut() {
  if (accessToken) {
    window.google?.accounts?.oauth2?.revoke(accessToken)
  }
  accessToken = null
  clearStoredToken()
}
