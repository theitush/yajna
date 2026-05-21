import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/yajna/',
  plugins: [react(), tailwindcss()],
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
