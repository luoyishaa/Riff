import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const backend = process.env.COLLAB_SERVER_PORT ?? '8787';
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy: { '/api': `http://127.0.0.1:${backend}`, '/ws': { target: `ws://127.0.0.1:${backend}`, ws: true } } } });
