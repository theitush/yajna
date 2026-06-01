/**
 * sync-core Drive client — the raw-fetch, gapi-free subset of Drive operations
 * needed to PUSH from off the page (service worker). It is the portable twin of
 * the blob-upload paths in drive.js, which already used `fetch` + a Bearer
 * header; the only thing they read from the page was the token, so the sole
 * change here is sourcing the token (and the 401-retry refresh) from an injected
 * token provider (see tokenProvider.js) instead of `window.gapi`.
 *
 * Scope is deliberately narrow — only what the first SW consumer (audio blob
 * upload) needs. The gapi-based folder/list operations in drive.js stay on the
 * page; the SW relies on folder ids already cached in IDB (`drive_files`), which
 * the page populates on init. As later CRDT pushes migrate, the `.bin`
 * read/write helpers join this module the same way.
 *
 * No `window`, `document`, or `gapi` references — safe to import into a worker.
 */

const UPLOAD_TIMEOUT_MS = 60_000

/** fetch with an AbortController timeout (mirrors drive.js:fetchWithTimeout). */
async function fetchWithTimeout(url, init = {}, ms = UPLOAD_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Drive fetch timed out')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Turn an auth-failure Response into a thrown error tagged with .status. */
async function ensureFetchOk(res, label) {
  if (res.ok) return res
  const err = await res.json().catch(() => ({}))
  const error = new Error(err.error?.message || `${label}: ${res.status}`)
  error.status = res.status
  throw error
}

function isAuthStatus(status) {
  return status === 401 || status === 403
}

/**
 * Run `makeRequest(token)` with the provider's current token; on a 401/403,
 * refresh once via the provider and retry. The portable analogue of auth.js's
 * withAuthRetry, but parameterized over the injected provider (no module-level
 * gapi token, no shared cooldown — a SW invocation is short-lived and one-shot).
 * makeRequest receives the token so a retry re-reads the refreshed one.
 */
async function withTokenRetry(provider, makeRequest) {
  const token = await provider.getToken()
  if (!token) throw Object.assign(new Error('Not authenticated'), { status: 401 })
  try {
    return await makeRequest(token)
  } catch (e) {
    if (!isAuthStatus(e?.status)) throw e
    const ok = await provider.refresh()
    if (!ok) throw e
    const fresh = await provider.getToken()
    if (!fresh) throw e
    return await makeRequest(fresh)
  }
}

/**
 * Upload an audio blob to Drive via multipart fetch. Portable twin of
 * drive.js:uploadAudioFile — same endpoint and form shape, token from the
 * provider. Returns the parsed `{ id, ... }` JSON. The FormData is rebuilt per
 * attempt because a Blob body is single-consumption (a retry can't replay it).
 */
export async function uploadAudioBlob(provider, parentId, name, blob) {
  const metadata = {
    name,
    mimeType: blob.type || 'audio/webm',
    parents: [parentId],
  }
  return withTokenRetry(provider, async (token) => {
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('media', blob)
    const res = await fetchWithTimeout(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
      UPLOAD_TIMEOUT_MS
    )
    await ensureFetchOk(res, 'Audio upload failed')
    return res.json()
  })
}
