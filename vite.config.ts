import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// PORT is the web UI port in development; the API runs separately (see src/server/dev.ts).
const apiPort = Number(process.env.COURSEKIT_API_PORT ?? 3000);
const webPort = Number(process.env.PORT ?? 5173);

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: webPort,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}` },
    },
  },
});
