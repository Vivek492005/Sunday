import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The bundle is served by the sunday-agent extension inside a VS Code webview.
// `base: './'` keeps asset URLs relative so ChatViewProvider can rewrite them
// to webview URIs and inject the CSP nonce.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
