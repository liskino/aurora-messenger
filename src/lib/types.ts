export type ChatKind = 'direct' | 'group'
export type MessageKind = 'text' | 'file' | 'system'

export interface Profile {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  public_key: string
  wrapped_private: string
  kdf_salt: string
  kdf_iterations: number
  last_seen: string
  created_at: string
}

export interface Chat {
  id: string
  kind: ChatKind
  title: string | null
  created_by: string
  created_at: string
}

export interface ChatMember {
  chat_id: string
  user_id: string
  wrapped_key: string
  joined_at: string
}

export interface Message {
  id: string
  chat_id: string
  sender_id: string
  ciphertext: string
  iv: string
  kind: MessageKind
  file_path: string | null
  file_name_sealed: string | null
  file_name_iv: string | null
  file_type: string | null
  file_size: number | null
  wrapped_file_key: string | null
  created_at: string
  edited_at: string | null
}

export interface Device {
  id: string
  user_id: string
  label: string
  user_agent: string | null
  last_active: string
  created_at: string
}

export interface Receipt {
  message_id: string
  user_id: string
  delivered_at: string | null
  read_at: string | null
}

/** Расшифрованное сообщение, готовое к отображению. */
export interface DecryptedMessage extends Message {
  text: string
  fileName?: string
  /** Локальное состояние: расшифровка не удалась (чужой ключ/повреждение). */
  failed?: boolean
}

export interface ChatView extends Chat {
  peer?: Profile
  members: Profile[]
  lastMessage?: DecryptedMessage
  unread: number
}