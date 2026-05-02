import { defineConfig } from 'vite'

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
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
