import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.COLLAB_SERVER_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': `http://127.0.0.1:${backend}`, '/ws': { target: `ws://127.0.0.1:${backend}`, ws: true } } },
  build: {
    rollupOptions: {
      output: {
        // Libraries change far less often than the app; separate chunks stay cached.
        manualChunks: {
          react: ['react', 'react-dom'],
          codemirror: ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-markdown', '@lezer/highlight'],
          collaboration: ['yjs', 'y-protocols/awareness', 'y-codemirror.next'],
        },
      },
    },
  },
});
