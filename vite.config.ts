import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

/**
 * Сборка клиента Aurora.
 *
 * Приложение автономное: сервер отдаёт и статику, и API с одного адреса,
 * поэтому базовый путь всегда корневой — ни GitHub Pages, ни переменных
 * окружения для развёртывания больше не требуется.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  build: {
    target: 'es2022',
    cssMinify: 'lightningcss',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // React отделяем от приложения: вендор меняется редко, и при
        // обновлении кода человеку не придётся загружать его заново.
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    // Разработка: страницу отдаёт Vite, а API слушает сервер на 8787.
    // Без прокси пришлось бы открывать два адреса и настраивать CORS вручную.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // Поток событий нельзя буферизовать: иначе сообщения приходят пачками.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            }
          })
        },
      },
    },
  },
})