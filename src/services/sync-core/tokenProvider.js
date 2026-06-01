/**
 * sync-core token provider — the single seam that lets the Drive push pipeline
 * run OFF the page (in a service worker), where `window.gapi` does not exist.
 *
 * Why this exists: the whole Drive layer historically read its OAuth access
 * token from `window.gapi.client.getToken()` and refreshed it through page-only
 * helpers. A service worker has no `window`, so to push from the SW we need the
 * token + refresh logic expressed against state that lives in IndexedDB (which
 * both the page and the SW can read) rather than in page memory.
 *
 * The good news (see project_sw_push_migration): the underlying auth state is
 * ALREADY IDB-backed — the access token is persisted by `storeToken` under
 * `goog_token`, and `trySilentRefresh` is a plain `fetch` against the auth
 * worker using the `goog_refresh_blob` IDB row. Neither touches gapi. So this
 * provider is a thin, window-free wrapper over the existing pure primitives.
 *
 * A "token provider" is `{ getToken, refresh }`:
 *   - getToken(): Promise<string|null>  — a currently-valid access token, or null.
 *   - refresh():  Promise<boolean>      — attempt a silent refresh; true on success.
 *
 * The page supplies its own provider (see auth.js) that prefers the live
 * in-memory gapi token for speed; the SW uses `headlessTokenProvider` below,
 * which is pure IDB + fetch and safe to import into a worker.
 */
import { getStoredToken, trySilentRefresh, storeToken } from '../auth'

/**
 * window-free token provider for service-worker / headless contexts.
 *
 * getToken: read the persisted token from IDB (already has a 60s expiry skew in
 * getStoredToken). If it's gone/expired, try a silent refresh and persist the
 * fresh token so the next read is a fast IDB hit. refresh: rotate the token via
 * the existing coalesced trySilentRefresh and persist it. Both return falsy
 * rather than throw on a missing refresh blob, so a logged-out SW just no-ops.
 */
export const headlessTokenProvider = {
  async getToken() {
    const existing = await getStoredToken()
    if (existing) return existing
    const refreshed = await trySilentRefresh()
    if (!refreshed) return null
    await storeToken(refreshed.token, refreshed.expiresIn)
    return refreshed.token
  },
  async refresh() {
    const refreshed = await trySilentRefresh()
    if (!refreshed) return false
    await storeToken(refreshed.token, refreshed.expiresIn)
    return true
  },
}
