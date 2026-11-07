import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false, cssCodeSplit: true },
  test: { environment: 'jsdom', globals: false, css: false },
});
