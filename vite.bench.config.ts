import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

/** Отдельная сборка стенда плавности — в приложение она не попадает. */
export default defineConfig({
  root: path.resolve(process.cwd(), 'bench'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  build: {
    outDir: path.resolve(process.cwd(), 'bench/dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(process.cwd(), 'bench/harness.html'),
    },
  },
})