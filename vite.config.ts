import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
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
