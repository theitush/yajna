/**
 * Yajna Auth Broker - Cloudflare Worker
 *
 * Implements Authorization Code Flow with PKCE for Google OAuth.
 * Holds the client_secret and encrypts refresh tokens for storage in the SPA.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigin = env.ALLOWED_ORIGIN;

    // Normalize origins for comparison (strip trailing slashes)
    const normalizedOrigin = origin ? origin.replace(/\/+$/, '') : '';
    const normalizedAllowed = allowedOrigin ? allowedOrigin.replace(/\/+$/, '') : '';

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': (allowedOrigin === '*' || normalizedOrigin === normalizedAllowed) ? origin : allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === '/health') {
        return new Response('ok', { headers: corsHeaders });
      }

      if (url.pathname === '/login') {
        return handleLogin(request, env);
      }

      if (url.pathname === '/callback') {
        return handleCallback(request, env);
      }

      if (url.pathname === '/refresh') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
        const res = await handleRefresh(request, env);
        // Add CORS to refresh response
        const newHeaders = new Headers(res.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(res.body, { ...res, headers: newHeaders });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error(err);
      return new Response(err.message || 'Internal Server Error', { status: 500, headers: corsHeaders });
    }
  }
};

/**
 * GET /login?redirect=<spa_url>
 */
async function handleLogin(request, env) {
  const url = new URL(request.url);
  const spaRedirect = url.searchParams.get('redirect');
  if (!spaRedirect) return new Response('Missing redirect param', { status: 400 });

  // 1. Generate PKCE verifier and challenge
  const verifier = generateRandomString(64);
  const challenge = await generateChallenge(verifier);

  // 2. Encrypt verifier and spaRedirect into the 'state' param to stay stateless
  const statePayload = JSON.stringify({ v: verifier, r: spaRedirect, t: Date.now() });
  const state = await encrypt(statePayload, env.TOKEN_ENCRYPTION_KEY);

  // 3. Construct Google Authorize URL
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${new URL(request.url).origin}/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent'
  });

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
}

/**
 * GET /callback?code=...&state=...
 */
async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return new Response(`Google Error: ${error}`, { status: 400 });
  if (!code || !state) return new Response('Missing code or state', { status: 400 });

  try {
    // 1. Decrypt state to get verifier and original redirect URL
    const statePayload = await decrypt(state, env.TOKEN_ENCRYPTION_KEY);
    const { v: verifier, r: spaRedirect, t: timestamp } = JSON.parse(statePayload);

    // CSRF/Timeout check: state should be recent (e.g. < 10 mins)
    if (Date.now() - timestamp > 600000) return new Response('Login session expired', { status: 400 });

    // 2. Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code: code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: `${new URL(request.url).origin}/callback`,
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return new Response(JSON.stringify(tokens), { status: tokenRes.status });

    // 3. Encrypt refresh token if present
    let refreshBlob = '';
    if (tokens.refresh_token) {
      refreshBlob = await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY);
    }

    // 4. Redirect back to SPA with tokens in fragment
    const fragment = new URLSearchParams({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      refresh_blob: refreshBlob
    });

    return Response.redirect(`${spaRedirect}#${fragment.toString()}`, 302);
  } catch (err) {
    return new Response(`Callback failed: ${err.message}`, { status: 500 });
  }
}

/**
 * POST /refresh
 * Body: { refresh_blob }
 */
async function handleRefresh(request, env) {
  const { refresh_blob } = await request.json();
  if (!refresh_blob) return new Response('Missing refresh_blob', { status: 400 });

  try {
    // 1. Decrypt refresh token
    const refreshToken = await decrypt(refresh_blob, env.TOKEN_ENCRYPTION_KEY);

    // 2. Call Google to refresh
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      return new Response(JSON.stringify(tokens), { status: tokenRes.status });
    }

    // 3. Re-encrypt (Google may rotate it, or we just want a fresh blob)
    const newRefreshToken = tokens.refresh_token || refreshToken;
    const newRefreshBlob = await encrypt(newRefreshToken, env.TOKEN_ENCRYPTION_KEY);

    return new Response(JSON.stringify({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      refresh_blob: newRefreshBlob
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response('Invalid or expired refresh session', { status: 401 });
  }
}

// --- Crypto Helpers ---

function generateRandomString(len) {
  const array = new Uint8Array(len);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .slice(0, len);
}

async function generateChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function getKey(base64Key) {
  const keyBuf = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', keyBuf, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(text, base64Key) {
  const key = await getKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  
  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function decrypt(blob, base64Key) {
  const key = await getKey(base64Key);
  const combined = Uint8Array.from(atob(blob.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
