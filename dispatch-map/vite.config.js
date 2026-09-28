import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

const commit = (process.env.COMMIT_REF || '').slice(0, 7) || 'dev';
const builtAt = new Date().toISOString();
// Netlify deploy context (CONTEXT): production | deploy-preview | branch-deploy | dev.
// Map to a short label; absent (local dev) → 'dev'. Never undefined.
const ctxRaw = process.env.CONTEXT || '';
const context = ctxRaw === 'production' ? 'prod'
  : ctxRaw === 'deploy-preview' ? 'preview'
  : ctxRaw === 'branch-deploy' ? 'branch'
  : (ctxRaw || 'dev');

// SWITCHES THE BROWSER AND THE SERVER BOTH READ, UNDER ONE NAME. Vite only hands VITE_-prefixed
// vars to the bundle, so TRAILER_ALERT_ANY_RESTRICTION=off (trailer-block.js) quieted the 9pm
// text on the server while the flag panel's R7 card, computed in the browser, stayed on the
// widened rule. Passed through at BUILD time, so flipping it takes a redeploy — as every Netlify
// env change already does. Defined only when set, so the VITE_ spelling stays reachable.
const sharedSwitches = Object.fromEntries(
  ['TRAILER_ALERT_ANY_RESTRICTION']
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [`import.meta.env.${k}`, JSON.stringify(process.env[k])]),
);

export default defineConfig({
  plugins: [
    react(),
    visualizer({
      filename: 'dist/bundle-stats.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
      open: false,
    }),
  ],
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(builtAt),
    __BUILD_CONTEXT__: JSON.stringify(context),
    ...sharedSwitches,
  },
});
