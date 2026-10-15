import { readEvents } from './lib/sse.mjs'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type Health = { status: string; configured: boolean; model: string }

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch('/api/health', { signal })
  if (!response.ok) throw new Error('Servidor indisponível')
  return response.json()
}

export async function streamReply(messages: ChatMessage[], signal: AbortSignal, onDelta: (text: string) => void) {
  const response = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }), signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || 'Não foi possível enviar. Confira se o backend está em execução.')
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('O servidor não retornou uma resposta em streaming.')
  }
  for await (const event of readEvents(response.body)) {
    if (event.type === 'error') throw new Error(event.error || 'Não foi possível concluir a resposta.')
    if (event.type === 'delta' && typeof event.delta === 'string') onDelta(event.delta)
    if (event.type === 'done') return
  }
  throw new Error('A conexão foi interrompida antes de concluir a resposta.')
}
