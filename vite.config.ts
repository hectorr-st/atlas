import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    watch: {
      // Don't watch the backend or its saved Chrome profile — the profile holds
      // thousands of cache files that exhaust the file-watcher limit (ENOSPC)
      // and crash the dev server.
      ignored: ['**/server/**'],
    },
  },
});
