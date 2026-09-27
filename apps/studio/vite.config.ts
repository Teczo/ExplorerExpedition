import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // The API sends no CORS headers, so in development the Studio calls it
    // through this proxy on its own origin: `/api/auth/me` -> `:3000/auth/me`.
    proxy: {
      '/api': {
        target: process.env.STUDIO_API_PROXY_TARGET ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
