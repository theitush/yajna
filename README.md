# 📓 Yajna

**Yet another journaling & notes app** — local-first, with no backend of its own. Your data lives in your browser and your Google Drive.

Journal · Notes · Todos · Voice.

## ✨ Features

- **Today** — daily journal with a rich-text editor (headings, lists, formatting, highlights, RTL).
- **Todos** — tasks with statuses; optionally auto-dismiss completed ones on day change.
- **Review** — a daily review flow surfacing past days and tasks that still need attention.
- **Notes** — standalone notes organized with `#hashtags` and inline tag autocomplete.
- **Voice & transcription** — record audio in-app; the audio file is saved. Transcribe with Whisper via [Groq](https://groq.com/) — bring your own free API key.
- **Full-text search** across journals, notes, and tasks.
- **Offline mode** — use the whole app with no account; data never leaves your device.
- **Export** all data to JSON anytime.
- **PWA** — installable, responsive, mobile-ready.

### Audio transcription setup

1. Get a free API key at [console.groq.com](https://console.groq.com/keys).
2. Paste it into **Settings → Groq API key** and pick a model.

Audio goes straight from your browser to Groq — not through any server of mine.

## 🔒 Privacy & data

Yajna has no backend for your data. Notes, tasks, journals, and audio are stored locally in your browser (IndexedDB) and synced into a single `yajna/` folder in *your* Google Drive — plain JSON files you can open, back up, or delete. Your content never passes through anything I run.

There's a tiny [Cloudflare Worker](worker/) (`worker/`) that does **one** job: the Google OAuth handshake, so you don't have to re-login every hour. It only ever handles tokens — never your notes or audio. The OAuth scope is `drive.file`, which limits access to the `yajna/` folder only, never the rest of your Drive.

**Honest disclosure — no end-to-end encryption yet.** Your data sits in Drive as plain JSON. That means Google can read it, and technically *I* could too if I accessed your `yajna/` folder. I don't, and I don't want to — but the architecture doesn't *prevent* it today.

Client-side encryption is **planned** so that no one but you can read your data. PRs welcome — see [issues](../../issues).

If you want a zero-trust setup right now: run **Offline mode**, or deploy your own auth worker (below) so the secrets are entirely yours.

## 🛠️ Tech stack

React 19 · Vite · Zustand · TipTap · Tailwind CSS v4 · Fuse.js · Cloudflare Workers · Google Drive API

## 🚀 Running it yourself

```bash
npm install
npm run dev      # dev server
npm run build    # production build
```

Set your Google OAuth client ID:

```bash
cp .env.example .env
# set VITE_GOOGLE_CLIENT_ID and (optionally) VITE_AUTH_WORKER_URL
```

To own the whole stack, deploy your own auth worker — then the `client_secret` and encryption key are yours alone:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY   # 32-byte base64 key
npx wrangler secret put ALLOWED_ORIGIN         # e.g. https://yourname.github.io
npx wrangler deploy
```

See [`worker/README.md`](worker/README.md) and [`docs/auth-migration.md`](docs/auth-migration.md) for details.
