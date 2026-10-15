import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, Check, ChevronDown, Code2, Copy, ExternalLink, Lightbulb, Menu, MessageSquare, PenLine, Plus, Search, Settings2, Sparkles, Square, Trash2, WandSparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getHealth, streamReply } from './api'
import type { Health } from './api'
import { loadConversations, newConversation, STORAGE_KEY } from './storage'
import type { Conversation, Message } from './storage'

const suggestions = [
  { icon: Lightbulb, color: 'peach', title: 'Tirar uma ideia do papel', text: 'Um primeiro passo para algo novo.', prompt: 'Tenho uma ideia e quero tirar do papel. Me ajude a organizar os primeiros passos, começando com algumas perguntas.' },
  { icon: PenLine, color: 'lavender', title: 'Encontrar as palavras', text: 'Escreva, revise ou dê outro tom.', prompt: 'Quero escrever um texto com mais clareza e personalidade. Me pergunte sobre o objetivo, o público e o tom antes de começarmos.' },
  { icon: Code2, color: 'mint', title: 'Descomplicar um código', text: 'Da primeira linha à solução.', prompt: 'Me ajude a entender ou resolver um problema de programação. Comece perguntando em qual linguagem estou trabalhando e qual é o problema.' },
  { icon: WandSparkles, color: 'yellow', title: 'Aprender algo diferente', text: 'Transforme curiosidade em descoberta.', prompt: 'Quero aprender algo novo hoje. Sugira três assuntos interessantes de áreas diferentes e me ajude a escolher um para explorar.' },
]

function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 40 40"><path d="m8 12 8 17h8l8-17h-8l-4 10-4-10Z" fill="currentColor" /></svg></span>
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
        event.preventDefault(); setSidebarOpen(true); searchInput.current?.focus()
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
  const statusText = healthLoading ? 'Conectando' : health?.configured ? 'Pronto para conversar' : health ? 'Configuração pendente' : 'Servidor desconectado'
  const filtered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).filter(c => c.messages.length && c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Fechar menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Conversas">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); createChat() }}><Mark /><span>vamo<span className="brand-period">.</span></span></a>
      <button className="new-chat" onClick={createChat} disabled={busy}><Plus size={18} /> Nova conversa <span className="new-badge">+</span></button>
      <label className="search"><Search size={16} /><input ref={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar conversas" aria-label="Buscar conversas" /><kbd>⌘ K</kbd></label>
      <div className="history-label">SEU ESPAÇO <span>{conversations.filter(c => c.messages.length).length.toString().padStart(2, '0')}</span></div>
      <div className="history">
        {filtered.length ? filtered.map(c => <div key={c.id} className={`history-item ${c.id === active.id ? 'active' : ''}`}>
          <button className="history-select" disabled={busy} onClick={() => { setActiveId(c.id); setDraft(''); setSidebarOpen(false); stickToBottom.current = true }}><MessageSquare size={15} /><span>{c.title}</span></button>
          <button className="delete-chat" disabled={busy} aria-label={`Excluir ${c.title}`} onClick={() => deleteChat(c.id)}><Trash2 size={14} /></button>
        </div>) : <div className="history-empty"><span className="empty-history-icon"><MessageSquare size={19} /></span><p>{search ? 'Nenhuma conversa encontrada.' : 'Tudo começa com uma conversa.'}</p><span>{search ? 'Tente buscar outra palavra.' : 'Suas ideias vão morar por aqui.'}</span></div>}
      </div>
      <div className="sidebar-bottom">
        <div className="little-note"><span className="note-spark">✳</span><p>Uma boa pergunta.<br /><strong>Infinitas possibilidades.</strong></p><span className="note-line" /></div>
        <button className="settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> Configurações <ArrowRight size={15} /></button>
        <div className="profile"><span className="avatar">V</span><div><strong>Meu espaço</strong><span>Conversas neste navegador</span></div><span className="profile-dot" /></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Abrir menu de conversas" onClick={() => setSidebarOpen(true)}><Menu size={21} /></button><span className="workspace-title">Seu parceiro de ideias</span><span className="topbar-separator" /><button className="model-chip" onClick={() => setSettingsOpen(true)}><span className="model-spark">✳</span> OpenAI <ChevronDown size={13} /></button></div>
        <div className={`connection-status ${health?.configured ? 'ready' : ''}`}><span />{statusText}</div>
      </header>

      <div ref={scroller} className={`chat-scroll ${isEmpty ? 'empty' : ''}`} onScroll={() => {
        if (!scroller.current) return
        stickToBottom.current = scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight < 120
        setShowScroll(!stickToBottom.current)
      }}>
        {isEmpty ? <section className="welcome" aria-label="Comece uma conversa">
          <div className="welcome-eyebrow"><span /> UM ESPAÇO PARA PENSAR JUNTO</div>
          <div className="hero-mark"><Mark /><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="hero-star">✦</span><span className="hero-dot" /></div>
          <h1>Boas ideias começam<br />com um <span>“e se?”<svg viewBox="0 0 190 16" preserveAspectRatio="none"><path d="M4 10Q90-1 184 8M22 14Q99 6 167 12" /></svg></span></h1>
          <p className="welcome-description">Um rascunho, uma dúvida, um plano para amanhã.<br />O que vamos tirar do papel hoje?</p>
          <div className="suggestions">{suggestions.map(({ icon: Icon, color, title, text, prompt }) => <button className="suggestion" key={title} onClick={() => { setDraft(prompt); composer.current?.focus() }}><span className={`suggestion-icon ${color}`}><Icon size={19} strokeWidth={1.7} /></span><ArrowRight className="suggestion-arrow" size={17} /><strong>{title}</strong><span className="suggestion-description">{text}</span></button>)}</div>
          <div className="welcome-footnote"><Sparkles size={13} /> Sua curiosidade é um ótimo ponto de partida.</div>
        </section> : <section className="messages" aria-label="Mensagens da conversa">
          <div className="conversation-heading"><span>CONVERSA EM ANDAMENTO</span><button onClick={exportChat} disabled={busy} title="Exportar conversa em Markdown"><ArrowDownToLine size={15} /> Exportar</button></div>
          {active.messages.map((message, index) => <article key={message.id} className={`message ${message.role}`}>
            <div className="message-avatar">{message.role === 'assistant' ? <Mark small /> : <span>V</span>}</div>
            <div className="message-body"><div className="message-author">{message.role === 'assistant' ? 'vamo' : 'Você'}{message.role === 'assistant' && <span>ASSISTENTE</span>}</div>
              <div className="message-content">{message.role === 'assistant' ? message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : !message.error && !message.interrupted && <span className="typing" aria-label="Preparando resposta"><i /><i /><i /></span> : <p>{message.content}</p>}</div>
              {message.interrupted && <div className="interrupted">Resposta interrompida.</div>}
              {message.error && <div className="message-error" role="alert"><p>{message.error}</p>{!busy && index === active.messages.length - 1 && <button onClick={() => void send(active.messages[index - 1]?.content || '', true)}>Tentar novamente <ArrowRight size={13} /></button>}</div>}
              {message.role === 'assistant' && message.content && !busy && <button className="copy-button" onClick={() => void copyMessage(message)}>{copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}{copiedId === message.id ? 'Copiado' : 'Copiar'}</button>}
            </div>
          </article>)}
        </section>}
      </div>

      <div className="composer-area">
        {showScroll && !isEmpty && <button className="scroll-bottom" aria-label="Ir para a última mensagem" onClick={() => { stickToBottom.current = true; scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }) }}><ArrowDown size={18} /></button>}
        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Fechar aviso" onClick={() => setNotice('')}><X size={15} /></button></div>}
        <form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={submit}>
          <textarea ref={composer} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} maxLength={16000} placeholder="Pode perguntar. A ideia é sua, a conversa é nossa." aria-label="Sua mensagem" rows={1} disabled={busy} />
          <div className="composer-bottom"><span className="composer-hint"><span className="hint-spark">✳</span> Um pouco de curiosidade vai longe.</span><div className="composer-actions"><span className="enter-hint">{draft.length > 14000 ? `${draft.length}/16000` : 'Enter para enviar'}</span>{busy ? <button className="send-button stop" type="button" title="Interromper resposta" aria-label="Interromper resposta" onClick={() => controller.current?.abort()}><Square size={16} fill="currentColor" /></button> : <button className="send-button" type="submit" disabled={!draft.trim()} title="Enviar mensagem" aria-label="Enviar mensagem"><ArrowUp size={20} /></button>}</div></div>
        </form>
        <div className="composer-caption"><span>Feito para conversar. Aberto a possibilidades.</span><span>A IA pode cometer erros. Confira informações importantes.</span></div>
      </div>
    </main>

    <dialog ref={settingsDialog} className="settings-dialog" onCancel={() => setSettingsOpen(false)} onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
      <div className="dialog-heading"><div><span className="dialog-eyebrow">DO SEU JEITO</span><h2>Seu espaço, configurado.</h2></div><button className="icon-button" aria-label="Fechar configurações" onClick={() => setSettingsOpen(false)}><X size={21} /></button></div>
      <div className="settings-status"><span className={`status-light ${health?.configured ? 'ready' : ''}`} /><div><strong>{statusText}</strong><p>{health?.configured ? 'O backend está pronto para enviar mensagens à OpenAI.' : health ? 'Configure sua chave no backend para começar.' : 'Inicie o servidor Go na porta 8080.'}</p></div></div>
      <label className="setting-label">MODELO NO BACKEND<code>{health?.model || 'Definido em OPENAI_MODEL'}</code></label>
      <div className="setup-instructions"><strong>Como conectar</strong><ol><li>Copie <code>backend/.env.example</code> para <code>backend/.env</code>.</li><li>Preencha <code>OPENAI_API_KEY</code> com sua chave.</li><li>Reinicie o backend com <code>go run .</code>.</li></ol><p>A chave fica somente no servidor. O modelo pode ser alterado em <code>OPENAI_MODEL</code>.</p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Gerenciar chave na OpenAI <ExternalLink size={13} /></a></div>
      <p className="privacy-note">O histórico fica neste navegador (até 30 conversas). Ao enviar, o conteúdo da conversa é encaminhado à OpenAI. Você pode excluir ou exportar suas conversas.</p>
      <button className="refresh-button" onClick={() => void refreshHealth()} disabled={checking}>{checking ? 'Verificando…' : 'Verificar conexão'}<ArrowRight size={16} /></button>
    </dialog>
  </div>
}
