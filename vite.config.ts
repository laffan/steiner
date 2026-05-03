import { defineConfig } from 'vite'
import { resolve } from 'path'

// `base: './'` keeps every asset URL relative so the same `dist/` works in
// three contexts: Tauri's `tauri://` protocol, GitHub Pages under
// `/<repo>/`, and a plain `vite preview` on localhost. An absolute base
// (`/`) would 404 on Pages and a hardcoded `/<repo>/` would break Tauri.
export default defineConfig({
  base: './',
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    host: '0.0.0.0',
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'oauth-callback': resolve(__dirname, 'oauth-callback.html'),
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
