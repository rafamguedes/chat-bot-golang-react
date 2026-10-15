export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  error?: string
  interrupted?: boolean
}
export type Conversation = { id: string; title: string; updatedAt: number; messages: Message[] }
export const STORAGE_KEY = 'vamo.conversations.v1'

export function newConversation(): Conversation {
  return { id: crypto.randomUUID(), title: 'Nova conversa', updatedAt: Date.now(), messages: [] }
}

export function loadConversations(): Conversation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is Conversation =>
      item && typeof item.id === 'string' && typeof item.title === 'string' &&
      typeof item.updatedAt === 'number' && Array.isArray(item.messages) && item.messages.length <= 101 &&
      item.messages.every((m: Message) => m && typeof m.id === 'string' &&
        (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' &&
        (m.error === undefined || typeof m.error === 'string')),
    ).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
  } catch { return [] }
}
