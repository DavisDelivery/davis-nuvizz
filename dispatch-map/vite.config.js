import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const commit = (process.env.COMMIT_REF || '').slice(0, 7) || 'dev';
const builtAt = new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(builtAt),
  },
});
