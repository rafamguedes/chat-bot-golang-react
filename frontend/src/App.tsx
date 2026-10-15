import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, Check, ChevronDown, Copy, ExternalLink, PanelLeft, Search, Settings2, Square, SquarePen, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getHealth, streamReply } from './api'
import type { Health } from './api'
import { loadConversations, newConversation, STORAGE_KEY } from './storage'
import type { Conversation, Message } from './storage'

function Mark() {
  return <svg className="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 6 5 6-5 6m9 0h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const saved = loadConversations()
    return saved.length ? saved : [newConversation()]
  })
  const [activeId, setActiveId] = useState(() => conversations[0].id)
  const active = conversations.find(c => c.id === activeId) || conversations[0]
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const sending = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const searchInput = useRef<HTMLInputElement>(null)
  const settingsDialog = useRef<HTMLDialogElement>(null)
  const [showScroll, setShowScroll] = useState(false)
  const [checking, setChecking] = useState(false)

  const refreshHealth = async () => {
    setChecking(true)
    try { setHealth(await getHealth(AbortSignal.timeout(5000))) }
    catch { setHealth(null) }
    finally { setHealthLoading(false); setChecking(false) }
  }

  useEffect(() => {
    const abort = new AbortController()
    getHealth(abort.signal).then(setHealth).catch(() => {}).finally(() => setHealthLoading(false))
    return () => abort.abort()
  }, [])
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    // Do not persist each streaming token; save a snapshot once generation settles.
    if (busy) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)) }
    catch { setNotice('O navegador não conseguiu salvar o histórico. Exporte a conversa para guardar uma cópia.') }
  }, [conversations, busy])
  useEffect(() => {
    if (stickToBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [active.messages])
  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto'
      composer.current.style.height = `${Math.min(composer.current.scrollHeight, 180)}px`
    }
  }, [draft])
  useEffect(() => {
    if (settingsOpen) settingsDialog.current?.showModal()
    else settingsDialog.current?.close()
  }, [settingsOpen])
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault(); setSidebarCollapsed(false); setSidebarOpen(true)
        requestAnimationFrame(() => searchInput.current?.focus())
      }
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  function updateMessages(conversationId: string, change: (messages: Message[]) => Message[]) {
    setConversations(previous => previous.map(c => c.id === conversationId ? { ...c, messages: change(c.messages), updatedAt: Date.now() } : c))
  }

  function createChat() {
    if (sending.current) return
    const empty = conversations.find(c => !c.messages.length)
    if (empty) setActiveId(empty.id)
    else {
      const next = newConversation()
      setConversations(previous => [next, ...[...previous].sort((a, b) => b.updatedAt - a.updatedAt)].slice(0, 30)); setActiveId(next.id)
    }
    setDraft(''); setSearch(''); setSidebarOpen(false); stickToBottom.current = true
    composer.current?.focus()
  }

  function deleteChat(id: string) {
    if (sending.current) return
    const remaining = conversations.filter(c => c.id !== id)
    const next = remaining.length ? remaining : [newConversation()]
    setConversations(next)
    if (id === active.id) { setActiveId(next[0].id); setDraft('') }
  }

  async function send(text: string, retry = false) {
    text = text.trim()
    if (sending.current || !text) return
    if (text.length > 16000) { setNotice('Use até 16.000 caracteres por mensagem.'); return }
    const conversationId = active.id
    const base = retry ? active.messages.slice(0, -1) : active.messages
    const context = base.filter(m => m.content && !m.error && !m.interrupted)
    const user: Message = { id: crypto.randomUUID(), role: 'user', content: text }
    const requestMessages = retry ? context : [...context, user]
    if (requestMessages.length > 100) { setNotice('Esta conversa atingiu 100 mensagens. Inicie uma nova para continuar.'); return }
    const assistant: Message = { id: crypto.randomUUID(), role: 'assistant', content: '' }
    sending.current = true
    setBusy(true); setDraft(''); setNotice(''); stickToBottom.current = true
    setConversations(previous => previous.map(c => c.id === conversationId ? {
      ...c, title: c.messages.length ? c.title : text.slice(0, 48), updatedAt: Date.now(),
      messages: [...base, ...(retry ? [] : [user]), assistant],
    } : c))
    const abort = new AbortController()
    controller.current = abort
    try {
      await streamReply(requestMessages.map(({ role, content }) => ({ role, content })), abort.signal, delta => {
        updateMessages(conversationId, messages => messages.map(m => m.id === assistant.id ? { ...m, content: m.content + delta } : m))
      })
    } catch (error) {
      if (abort.signal.aborted) {
        updateMessages(conversationId, messages => messages.map(m => m.id === assistant.id ? { ...m, interrupted: true } : m))
      } else {
        const errorText = error instanceof Error ? error.message : 'Não foi possível obter uma resposta.'
        updateMessages(conversationId, messages => messages.map(m => m.id === assistant.id ? { ...m, error: errorText } : m))
      }
    } finally {
      controller.current = null; sending.current = false; setBusy(false)
      composer.current?.focus()
    }
  }

  function submit(event: FormEvent) { event.preventDefault(); void send(draft) }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); void send(draft)
    }
  }
  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content); setCopiedId(message.id)
      window.setTimeout(() => setCopiedId(''), 1800)
    } catch { setNotice('Não foi possível copiar. Selecione o texto e use Ctrl+C.') }
  }
  function exportChat() {
    const markdown = `# ${active.title}\n\n` + active.messages.map(m => `## ${m.role === 'user' ? 'Você' : 'Vamo'}\n\n${m.content}${m.error ? `\n\nErro: ${m.error}` : ''}${m.interrupted ? '\n\n[Resposta interrompida]' : ''}`).join('\n\n')
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'conversa-vamo.md'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const isEmpty = active.messages.length === 0
  const statusText = healthLoading ? 'Conectando…' : health?.configured ? 'Chave configurada' : health ? 'Chave não configurada' : 'Servidor desconectado'
  const filtered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).filter(c => c.messages.length && c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))

  function toggleSidebar() {
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(previous => !previous)
    else setSidebarCollapsed(previous => !previous)
  }

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Fechar menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Conversas">
      <div className="sidebar-header">
        <a className="brand" href="#" onClick={e => { e.preventDefault(); createChat() }} aria-label="Vamo, nova conversa"><Mark /><span>Vamo</span></a>
        <button className="icon-button" aria-label="Recolher barra lateral" title="Recolher barra lateral" onClick={toggleSidebar}><PanelLeft size={17} /></button>
      </div>
      <nav className="sidebar-nav" aria-label="Navegação principal">
        <button className="new-chat" onClick={createChat} disabled={busy}><SquarePen size={17} strokeWidth={1.7} /><span>Nova conversa</span></button>
        <label className="search"><Search size={17} strokeWidth={1.7} /><input ref={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar conversas" aria-label="Buscar conversas" /><kbd>Ctrl K</kbd></label>
      </nav>
      <div className="history-label">Conversas</div>
      <div className="history">
        {filtered.length ? filtered.map(c => <div key={c.id} className={`history-item ${c.id === active.id ? 'active' : ''}`}>
          <button className="history-select" aria-current={c.id === active.id ? 'page' : undefined} disabled={busy} onClick={() => { setActiveId(c.id); setDraft(''); setSidebarOpen(false); stickToBottom.current = true }}><span>{c.title}</span></button>
          <button className="delete-chat" disabled={busy} aria-label={`Excluir ${c.title}`} onClick={() => deleteChat(c.id)}><Trash2 size={14} /></button>
        </div>) : <p className="history-empty">{search ? 'Nenhum resultado.' : 'Suas conversas aparecem aqui.'}</p>}
      </div>
      <div className="sidebar-bottom">
        <button className="settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} strokeWidth={1.7} /><span>Configurações</span></button>
        <div className="profile"><span className="avatar">V</span><span>Espaço pessoal</span><span className="local-badge">Local</span></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button show-sidebar" aria-label="Mostrar barra lateral" title="Mostrar barra lateral" onClick={toggleSidebar}><PanelLeft size={18} /></button><span className="workspace-title">{isEmpty ? 'Nova conversa' : active.title}</span></div>
        <div className="topbar-actions">{!isEmpty && <button className="icon-button" onClick={exportChat} disabled={busy} aria-label="Exportar conversa em Markdown" title="Exportar conversa"><ArrowDownToLine size={17} /></button>}<button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Abrir configurações" title="Configurações"><Settings2 size={18} /></button></div>
      </header>

      <div className={`workspace ${isEmpty ? 'is-empty' : ''}`}>
      <div ref={scroller} className={`chat-scroll ${isEmpty ? 'empty' : ''}`} onScroll={() => {
        if (!scroller.current) return
        stickToBottom.current = scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight < 120
        setShowScroll(!stickToBottom.current)
      }}>
        {isEmpty ? <section className="welcome" aria-label="Comece uma conversa">
          <h1>O que vamos criar?</h1>
        </section> : <section className="messages" aria-label="Mensagens da conversa">
          {active.messages.map((message, index) => <article key={message.id} className={`message ${message.role}`}>
            <div className="message-body"><div className="message-author">{message.role === 'assistant' ? 'Vamo' : 'Você'}</div>
              <div className="message-content">{message.role === 'assistant' ? message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : !message.error && !message.interrupted && <span className="typing" aria-label="Preparando resposta"><i /><i /><i /></span> : <p>{message.content}</p>}</div>
              {message.interrupted && <div className="interrupted">Resposta interrompida.</div>}
              {message.error && <div className="message-error" role="alert"><p>{message.error}</p>{!busy && index === active.messages.length - 1 && <button onClick={() => void send(active.messages[index - 1]?.content || '', true)}>Tentar novamente <ArrowRight size={13} /></button>}</div>}
              {message.role === 'assistant' && message.content && !busy && <button className="copy-button" aria-label={copiedId === message.id ? 'Resposta copiada' : 'Copiar resposta'} title={copiedId === message.id ? 'Copiado' : 'Copiar resposta'} onClick={() => void copyMessage(message)}>{copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}</button>}
            </div>
          </article>)}
        </section>}
      </div>

      <div className="composer-area">
        {showScroll && !isEmpty && <button className="scroll-bottom" aria-label="Ir para a última mensagem" onClick={() => { stickToBottom.current = true; scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }) }}><ArrowDown size={18} /></button>}
        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Fechar aviso" onClick={() => setNotice('')}><X size={15} /></button></div>}
        <form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={submit}>
          <textarea ref={composer} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} maxLength={16000} placeholder="Pergunte ou peça alguma coisa…" aria-label="Sua mensagem" rows={1} disabled={busy} />
          <div className="composer-bottom"><button type="button" className="model-button" onClick={() => setSettingsOpen(true)} title="Configurações do modelo">{health?.model || 'Modelo'}<ChevronDown size={13} /></button><div className="composer-actions"><span className="enter-hint">{draft.length > 14000 ? `${draft.length}/16000` : 'Local'}</span>{busy ? <button className="send-button stop" type="button" title="Interromper resposta" aria-label="Interromper resposta" onClick={() => controller.current?.abort()}><Square size={13} fill="currentColor" /></button> : <button className="send-button" type="submit" disabled={!draft.trim()} title="Enviar mensagem" aria-label="Enviar mensagem"><ArrowUp size={18} strokeWidth={2.2} /></button>}</div></div>
        </form>
        <div className="composer-caption">Vamo pode cometer erros. Confira as respostas.</div>
      </div>
      </div>
    </main>

    <dialog ref={settingsDialog} className="settings-dialog" onCancel={() => setSettingsOpen(false)} onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
      <div className="dialog-heading"><h2>Configurações</h2><button className="icon-button" aria-label="Fechar configurações" onClick={() => setSettingsOpen(false)}><X size={19} /></button></div>
      <div className="settings-status"><span className={`status-light ${health?.configured ? 'ready' : ''}`} /><div><strong>{statusText}</strong><p>{health?.configured ? 'O backend está pronto para enviar mensagens à OpenAI.' : health ? 'Configure sua chave no backend para começar.' : 'Inicie o servidor Go na porta 8080.'}</p></div></div>
      <label className="setting-label">Modelo<code>{health?.model || 'Definido em OPENAI_MODEL'}</code></label>
      <div className="setup-instructions"><strong>Como conectar</strong><ol><li>Copie <code>backend/.env.example</code> para <code>backend/.env</code>.</li><li>Preencha <code>OPENAI_API_KEY</code> com sua chave.</li><li>Reinicie o backend com <code>go run .</code>.</li></ol><p>A chave fica somente no servidor. O modelo pode ser alterado em <code>OPENAI_MODEL</code>.</p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Gerenciar chave na OpenAI <ExternalLink size={13} /></a></div>
      <p className="privacy-note">O histórico fica neste navegador (até 30 conversas). Ao enviar, o conteúdo da conversa é encaminhado à OpenAI. Você pode excluir ou exportar suas conversas.</p>
      <button className="refresh-button" onClick={() => void refreshHealth()} disabled={checking}>{checking ? 'Verificando…' : 'Verificar conexão'}<ArrowRight size={16} /></button>
    </dialog>
  </div>
}
