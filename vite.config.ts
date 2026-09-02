import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // NOTE: do not add `optimizeDeps.exclude: ['lucide-react']` here. Excluding it
  // skips dep pre-bundling, so the dev server hands the browser lucide's barrel
  // file and it then fetches ~1,400 individual icon modules on every page load —
  // the app sat blank for seconds before React could run. Pre-bundling (the
  // default) collapses that to a single request. Production builds are
  // unaffected either way, since Rollup tree-shakes the barrel.
  server: {
    watch: {
      // Don't watch the backend or its saved Chrome profile — the profile holds
      // thousands of cache files that exhaust the file-watcher limit (ENOSPC)
      // and crash the dev server. On Windows the locked profile files fail the
      // watch outright (EBUSY). The second pattern catches a profile created
      // outside server/, which the first one would miss.
      ignored: ['**/server/**', '**/.session/**'],
    },
  },
});
