// vite.worker.config.ts
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: '.vite/build/workers',
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'src/workers/thumbWorker.ts'),
      formats: ['cjs'],
      fileName: () => 'thumbWorker.js'
    },
    rollupOptions: {
      external: ['sharp', 'better-sqlite3'],
    },
    target: 'node18'
  }
});
