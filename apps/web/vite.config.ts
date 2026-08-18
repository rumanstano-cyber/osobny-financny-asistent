import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Render Static Site serves this SPA from the domain root. Keep generated
  // JavaScript and CSS asset URLs rooted at `/assets/...` in production.
  base: '/',
  server: { host: '0.0.0.0', port: 5173 },
});
