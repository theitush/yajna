# Yajna Auth Worker

Cloudflare Worker that brokers Google OAuth 2.0 Authorization Code flow with PKCE for the Yajna SPA.

## Deployment

1. Install Wrangler: `npm install -g wrangler`
2. Login to Cloudflare: `wrangler login`
3. Set secrets:
   ```bash
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put TOKEN_ENCRYPTION_KEY # 32-byte base64
   wrangler secret put ALLOWED_ORIGIN # e.g. https://yourname.github.io
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```

## Development

```bash
npm install
npm start
```
