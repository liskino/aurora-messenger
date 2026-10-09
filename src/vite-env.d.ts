/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Адрес сервера. Пусто — клиент и сервер на одном порту. */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}