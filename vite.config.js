import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/yajna/',
  plugins: [
    react(),
    tailwindcss(),
    // Offline app shell. Custom src/sw.js (injectManifest) instead of the
    // generated cache-first SW: navigations stay network-first so an online
    // refresh always picks up a fresh deploy — see src/sw.js for the full
    // strategy. Dev server is untouched (no SW outside `vite build`).
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      manifest: false,
      injectManifest: {
        // Everything hashed/immutable — but NOT index.html, which must stay
        // network-first (src/sw.js handles it as a navigation).
        globPatterns: ['**/*.{js,css,svg,woff2,wasm}'],
        // The base64-inlined automerge WASM chunk is ~1.7MB; raise the limit
        // so it precaches (offline journal/tasks need it).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  // @automerge/automerge ships a `browser` export that loads its WASM via a
  // bare `import "./automerge_wasm_bg.wasm"`, which rolldown can't bundle.
  // Drop the `browser` condition so resolution falls through to the default
  // `import` condition, which points at the base64-inlined entrypoint
  // (fullfat_base64.js — ~150KB gz, no WASM loader plugin needed).
  resolve: {
    conditions: ['module', 'production', 'import'],
  },
  ssr: {
    resolve: {
      conditions: ['module', 'production', 'import'],
    },
  },
})
