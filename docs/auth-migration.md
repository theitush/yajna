# Auth migration: implicit flow → Worker-brokered refresh tokens

Goal: stay logged in indefinitely. Move from browser-only OAuth implicit flow (1h tokens, no refresh) to Authorization Code + PKCE brokered through a Cloudflare Worker that holds the client secret and refreshes tokens on demand.

Result: login persists for ~6 months of inactivity, refreshed automatically. No more hourly reauth.

---

## Architecture

```
[SPA on GitHub Pages]  ←→  [Cloudflare Worker]  ←→  [Google OAuth]
                                  ↑
                          holds client_secret,
                          does token exchange,
                          encrypts refresh_token
                          back to SPA
```

Refresh token is encrypted server-side and stored in the SPA's IndexedDB. SPA can't decrypt it; only the Worker can. To get a fresh access token, SPA sends ciphertext to Worker, Worker decrypts → calls Google → returns new access token.

This avoids needing a custom domain (which would be required for cross-site cookies between `*.github.io` and `*.workers.dev`).

---

## Part A — DevOps fiddling (you do this)

### A1. Cloudflare account + Worker setup

1. Sign up at https://dash.cloudflare.com/sign-up (free, no card needed).
2. Install Wrangler: `npm i -g wrangler`
3. `wrangler login` — opens browser, authorize.
4. Pick a Worker name. Suggestion: `yajna-auth`. Your Worker URL will be `https://yajna-auth.<your-cf-subdomain>.workers.dev`. Note this URL — you'll need it in A2 and B1.

### A2. Google Cloud Console — switch to Authorization Code flow

The existing OAuth client uses implicit flow. We need a client that supports the code flow with a client_secret.

1. Go to https://console.cloud.google.com/apis/credentials
2. Find the existing OAuth 2.0 Client ID used for yajna. Either:
   - **Edit it** (simpler): add the Worker callback URL to "Authorized redirect URIs" → `https://yajna-auth.<your-cf-subdomain>.workers.dev/callback`
   - **OR create a new "Web application" client** if you want to keep the old one intact. New client also needs the redirect URI above.
3. After saving, click "Download JSON" or copy the **Client ID** and **Client Secret**. The secret only appears once on creation; if you lose it, generate a new one.
4. Under "Authorized JavaScript origins", make sure your SPA origin is listed (e.g. `https://theitush.github.io` or wherever yajna is hosted).
5. Under "OAuth consent screen", confirm the scopes include:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`

### A3. Set Worker secrets

Once the Worker code exists (Part B), from the project root run:

```bash
wrangler secret put GOOGLE_CLIENT_ID
# paste client ID when prompted

wrangler secret put GOOGLE_CLIENT_SECRET
# paste client secret when prompted

wrangler secret put TOKEN_ENCRYPTION_KEY
# paste a 32-byte base64 key. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

wrangler secret put ALLOWED_ORIGIN
# paste your SPA origin, e.g. https://theitush.github.io
```

### A4. Deploy the Worker

```bash
wrangler deploy
```

Verify: `curl https://yajna-auth.<your-cf-subdomain>.workers.dev/health` should return `ok`.

### A5. Configure the SPA

Add to your `.env.local` (and to GitHub Pages build env if applicable):

```
VITE_AUTH_WORKER_URL=https://yajna-auth.<your-cf-subdomain>.workers.dev
```

Keep `VITE_GOOGLE_CLIENT_ID` as-is (the SPA still needs it for the initial redirect URL construction — though the Worker could also do this; see B1).

### A6. First login test

1. `npm run dev`
2. Click login → should redirect to Google → redirect to Worker `/callback` → redirect back to SPA with auth complete.
3. Open DevTools → Application → IndexedDB → check the `meta` store contains an encrypted refresh blob.
4. Manually expire token (set `expiresAt` to past in IndexedDB) → reload → should silently refresh via Worker, no Google UI.

### A7. Old client cleanup (optional)

Once verified working, in Google Cloud Console you can remove the old implicit-flow redirect URIs (your-spa-origin paths) from the OAuth client — they're no longer used.

---

## Part B — AI coding prompts

Run these in order. Each is meant for a coding agent (Claude Code, Cursor, etc.) inside this repo.

### B1. Build the Cloudflare Worker

> Create a Cloudflare Worker at `worker/src/index.js` plus `worker/wrangler.toml` and `worker/package.json`. The Worker brokers Google OAuth Authorization Code flow with PKCE for the yajna SPA so the SPA can hold long-lived refresh tokens (encrypted) without exposing the client secret.
>
> Endpoints:
> - `GET /health` → returns `ok`
> - `GET /login?redirect=<spa_url>` → generates PKCE verifier+challenge, stores verifier in a short-lived signed state cookie (or returns it via state param encrypted), redirects to Google's authorize URL with `response_type=code`, `access_type=offline`, `prompt=consent`, scopes `https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email`, the SPA's redirect target carried in state.
> - `GET /callback` → receives `code` + `state`, exchanges code for tokens at `https://oauth2.googleapis.com/token` using `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + PKCE verifier. Encrypts the refresh_token with AES-GCM using `TOKEN_ENCRYPTION_KEY`. Redirects user back to the SPA URL from state with `#access_token=...&expires_in=...&refresh_blob=<base64>` in the fragment.
> - `POST /refresh` → body `{ refresh_blob }`. Decrypts blob, calls Google token endpoint with `grant_type=refresh_token`, returns `{ access_token, expires_in, refresh_blob }` (re-encrypted; Google may rotate the refresh token). On Google rejection (revoked/expired), return 401.
>
> CORS: only allow `ALLOWED_ORIGIN`. Use `Access-Control-Allow-Origin` exact match, `Allow-Credentials: false` (we use blob-in-body, not cookies).
>
> Secrets read from env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (base64 32 bytes), `ALLOWED_ORIGIN`.
>
> Use Web Crypto API (available in Workers runtime) for AES-GCM and PKCE SHA-256. No external deps. Module-format Worker (`export default { fetch }`).
>
> Include a brief `worker/README.md` with deploy commands.

### B2. Replace SPA auth code

> Refactor `src/services/auth.js` and the auth flow in `src/App.jsx` to use the new Cloudflare Worker auth broker instead of Google's implicit flow.
>
> Worker URL is in `import.meta.env.VITE_AUTH_WORKER_URL`. Add this constant to `src/lib/constants.js` as `AUTH_WORKER_URL`.
>
> Changes to `src/services/auth.js`:
> - DELETE: `loadGIS`, `trySilentRefreshGIS`, `trySilentRefreshIframe`, `trySilentRefresh`, `startAuthRedirect`, `consumeAuthRedirect` (the implicit-flow + GIS silent-refresh machinery is gone).
> - Keep: `loadGAPI`, `initGAPI`, `getStoredToken`, `storeToken`, `clearStoredToken`, `getTokenRemainingSeconds`, `getAccessToken`, `setAccessToken`, `signOut`, `scheduleTokenRefresh`.
> - ADD `startAuthRedirect()` (new impl): `window.location.assign(\`\${AUTH_WORKER_URL}/login?redirect=\${encodeURIComponent(window.location.origin + window.location.pathname)}\`)`.
> - ADD `consumeAuthRedirect()` (new impl): parses `#access_token=...&expires_in=...&refresh_blob=...` from the URL fragment, validates presence, strips fragment, returns `{ token, expiresIn, refreshBlob }` or null. Same fragment-stripping behavior as before so HashRouter sees a clean URL.
> - ADD `storeRefreshBlob(blob)` / `getRefreshBlob()` / `clearRefreshBlob()` using the existing `meta` store (key `goog_refresh_blob`).
> - REPLACE `trySilentRefresh()` with: POST to `\${AUTH_WORKER_URL}/refresh` with `{ refresh_blob }` from storage. On success, persist the rotated refresh_blob and return `{ token, expiresIn }`. On 401 or network error, return null. No more GIS, no more iframe.
> - `signOut` should also clear the refresh blob.
>
> Changes to `src/App.jsx`:
> - In the redirect-handling branch, also persist `redirectResult.refreshBlob` via `storeRefreshBlob`.
> - All `trySilentRefresh()` callers stay the same (the function signature is unchanged).
> - Remove any GIS-related imports / preloads.
>
> Do not change the public API surface beyond the deletions/additions listed. Keep all existing comments that are still accurate; remove ones that reference GIS / iframe / FedCM.

### B3. Smoke test checklist (manual)

> After B1 + B2 are deployed, verify:
> 1. Fresh login from a logged-out state completes without Google showing a consent screen on subsequent logins (only first time).
> 2. Force token expiry (edit IndexedDB `meta.goog_token.expiresAt` to past) → reload → app silently refreshes, no UI.
> 3. Wait >1 hour with the tab open → token auto-refreshes via the scheduled timer, no UI.
> 4. Close laptop overnight, reopen tab → on visibility change, token refreshes silently.
> 5. Sign out → IndexedDB `meta.goog_refresh_blob` is gone → next login shows Google consent again.
> 6. Manually corrupt the refresh blob → `/refresh` returns 401 → app falls back to `handleTokenExpired` which re-prompts login.

---

## Rollback plan

If something breaks in production:
1. Revert the SPA commit (B2) → SPA goes back to implicit flow + 1h reauth.
2. Worker can keep running; old SPA just won't call it.
3. Remove the redirect URI from Google Cloud Console if you want a clean revert.

The Worker and SPA changes are independent deploys — you can roll back either one alone.

---

## Security notes

- The encryption key (`TOKEN_ENCRYPTION_KEY`) is the only thing protecting refresh tokens at rest in the user's browser. If it leaks, an attacker with the user's IndexedDB contents can mint access tokens. Treat it like a database password — Cloudflare secrets are fine; never commit it.
- The refresh blob in IndexedDB is bound to the Worker, not to the user. This means if someone exfiltrates a user's IndexedDB, they can use that blob from anywhere until you rotate the encryption key (which invalidates all blobs and forces every user to re-login).
- CORS lockdown to `ALLOWED_ORIGIN` prevents other sites from calling `/refresh` with a stolen blob via a victim's browser. It does not prevent direct curl with a stolen blob — that's why the encryption key matters.
- Google's refresh tokens self-expire after 6 months of non-use, after password change, or on explicit revoke at https://myaccount.google.com/permissions.
