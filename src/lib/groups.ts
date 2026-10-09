/**
 * Управление групповыми чатами.
 *
 * Ключевая сложность групп: у каждого участника свой ключ чата, завёрнутый
 * на секрет ECDH с создателем. Значит, добавить человека в группу может
 * только тот, кто этот ключ знает, — то есть создатель или участник,
 * у которого ключ развёрнут.
 *
 * Здесь это решается явно: тот, кто добавляет, сам выдаёт новому участнику
 * обёртку ключа. Если ключ чата у него не развёрнут — операция честно
 * отклоняется с понятной причиной, а не тихо ломает чат.
 */
import * as api from './api'
import * as crypto from './crypto'
import * as vault from './vault'
import { engine } from './engine'
import type { Chat, Profile } from './types'

export interface GroupMemberView {
  profile: Profile
  isSelf: boolean
  isCreator: boolean
}

/**
 * Создать группу.
 * Ключ чата раскладывается каждому участнику: иначе добавленные люди
 * не смогут прочитать ни одного сообщения.
 */
export async function createGroup(
  members: Profile[],
  title: string,
): Promise<Chat> {
  if (members.length < 2) {
    throw new Error('В группе нужно минимум два участника, кроме вас')
  }
  return engine.createChat(members, title)
}

/**
 * Добавить участника в существующую группу.
 *
 * Нужно передать ключ чата новому участнику. Если ключ не развёрнут —
 * значит, это не наша группа в терминах ключей, и добавлять нельзя.
 */
export async function addGroupMember(chatId: string, profile: Profile): Promise<void> {
  const session = engine.session
  if (!session) throw new Error('Нет активной сессии')

  const chat = await api.getChatsByIds([chatId])
  if (!chat[0]) throw new Error('Группа не найдена')
  if (chat[0].kind !== 'group') throw new Error('Это не групповая переписка')

  let chatKey: CryptoKey
  try {
    chatKey = await engine.keyForChat(chatId)
  } catch {
    throw new Error('У вас нет ключа этой группы — приглашать не может только создатель')
  }

  // Обёртка для нового участника: секрет ECDH между мной и им.
  const shared = await crypto.deriveSharedKey(session.privateKey, profile.public_key)
  const wrapped = await crypto.wrapChatKey(chatKey, shared)

  await api.upsertMembers([{ chat_id: chatId, user_id: profile.id, wrapped_key: wrapped }])
}

/** Исключить участника. Себя можно удалить — это выход из группы. */
export async function removeGroupMember(chatId: string, userId: string): Promise<void> {
  await api.removeMember(chatId, userId)
}

/** Переименовать группу. */
export async function renameGroup(chatId: string, title: string): Promise<void> {
  const clean = title.trim()
  if (!clean) throw new Error('Название не может быть пустым')
  if (clean.length > 60) throw new Error('Слишком длинное название')
  await api.updateChatTitle(chatId, clean)
}

/**
 * Список участников с ролями.
 * Создатель определяется по полю чата, а не по порядку в списке.
 */
export async function listGroupMembers(chatId: string): Promise<GroupMemberView[]> {
  const selfId = engine.session?.userId
  const chat = await api.getChatsByIds([chatId])
  const members = await engine.chatMembers(chatId)

  return members.map((profile) => ({
    profile,
    isSelf: profile.id === selfId,
    isCreator: profile.id === chat[0]?.created_by,
  }))
}

/**
 * Выход из группы.
 * Ключ чата стираем локально: после выхода читать историю нечем, и это
 * правильное поведение, а не потеря данных.
 */
export async function leaveGroup(chatId: string): Promise<void> {
  const selfId = engine.session?.userId
  if (!selfId) throw new Error('Нет активной сессии')

  await api.removeMember(chatId, selfId)
  engine.session?.chatKeys.delete(chatId)
  engine.session?.localWrapped.delete(chatId)
  await vault.dropChatKey(chatId)
}