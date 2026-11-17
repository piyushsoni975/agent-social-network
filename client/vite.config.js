import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the UI on :5173 and forwards /api (REST + SSE) to the Express server on :3000.
// In production, `npm run build` writes dist/, which Express serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
