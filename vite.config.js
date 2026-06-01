import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/yajna/',
  plugins: [
    react(),
    tailwindcss(),
    // Service worker for off-page audio push (project_sw_push_migration).
    // injectManifest = we author the whole SW (src/sw/sw.js); the plugin only
    // bundles it to a stable, un-hashed /yajna/sw.js and (here) precaches
    // nothing — it's a push-only worker, not an offline-app cache.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.js',
      injectRegister: null, // we register manually in main.jsx
      injectManifest: {
        // Push-only worker: don't precache the app bundle.
        globPatterns: [],
      },
      // No web manifest generated; we're not (yet) an installable PWA.
      manifest: false,
      devOptions: {
        enabled: true,
        type: 'module',
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
