import { Component, OnInit, inject, signal, viewChild, ElementRef, HostListener } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { JsonPipe, AsyncPipe } from '@angular/common'
import { ChatService, type Session, type Message } from './chat.service'
import { MarkdownPipe } from './markdown.pipe'

export interface ToolEvent {
  id: string
  type: 'tool_start' | 'tool_end' | 'tool_error'
  toolName: string
  expanded: boolean
  toolArgs?: Record<string, any>
  toolResult?: string
  error?: string
}

@Component({
  selector: 'app-root',
  imports: [FormsModule, JsonPipe, AsyncPipe, MarkdownPipe],
  templateUrl: './app.html',
})
export class App implements OnInit {
  private api = inject(ChatService)

  sessions = signal<Session[]>([])
  messages = signal<Message[]>([])
  toolEvents = signal<ToolEvent[]>([])
  currentSession = signal<Session | null>(null)
  input = signal('')
  loading = signal(false)
  currentTheme = signal('light')
  themeOpen = signal(false)
  sidebarOpen = signal(true)

  themes = [
    { value: 'light', label: 'Light', icon: '☀️' },
    { value: 'dark', label: 'Dark', icon: '🌙' },
    { value: 'midnight', label: 'Midnight', icon: '🌠' },
    { value: 'warm', label: 'Warm', icon: '🔥' },
    { value: 'forest', label: 'Forest', icon: '🌲' },
  ]

  chatContainer = viewChild<ElementRef>('chatContainer')

  ngOnInit() {
    const saved = localStorage.getItem('localclaw-theme')
    const valid = saved && this.themes.some((t) => t.value === saved)
    if (valid) {
      this.currentTheme.set(saved!)
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      this.currentTheme.set('dark')
    }
    this.applyTheme()
    this.loadSessions()
  }

  getThemeIcon(): string {
    const t = this.themes.find((t) => t.value === this.currentTheme())
    return t ? t.icon : ''
  }

  setTheme(value: string) {
    this.currentTheme.set(value)
    this.themeOpen.set(false)
    this.applyTheme()
    localStorage.setItem('localclaw-theme', value)
  }

  toggleTheme() {
    this.themeOpen.update((v) => !v)
  }

  toggleSidebar() {
    this.sidebarOpen.update((v) => !v)
  }

  hasKeys(obj: any): boolean {
    return obj != null && typeof obj === 'object' && Object.keys(obj).length > 0
  }

  @HostListener('document:click')
  onDocClick() {
    this.themeOpen.set(false)
  }

  private applyTheme() {
    document.documentElement.setAttribute('data-theme', this.currentTheme())
  }

  loadSessions() {
    this.api.getSessions().subscribe((s) => {
      this.sessions.set(s)
      if (s.length > 0 && !this.currentSession()) {
        this.selectSession(s[0])
      }
    })
  }

  selectSession(session: Session) {
    this.currentSession.set(session)
    this.toolEvents.set([])
    this.api.getMessages(session.id).subscribe((msgs) => {
      this.messages.set(msgs)
    })
  }

  newSession() {
    this.api.createSession().subscribe((s) => {
      this.sessions.update((list) => [s, ...list])
      this.selectSession(s)
    })
  }

  deleteCurrent(e?: Event) {
    e?.stopPropagation()
    const s = this.currentSession()
    if (!s) return
    this.api.deleteSession(s.id).subscribe(() => {
      this.sessions.update((list) => list.filter((x) => x.id !== s.id))
      const remaining = this.sessions()
      if (remaining.length > 0) {
        this.selectSession(remaining[0])
      } else {
        this.currentSession.set(null)
        this.messages.set([])
        this.toolEvents.set([])
      }
    })
  }

  deleteSession(e: Event, id: string) {
    e.stopPropagation()
    this.api.deleteSession(id).subscribe(() => {
      this.sessions.update((list) => list.filter((x) => x.id !== id))
      if (this.currentSession()?.id === id) {
        const remaining = this.sessions()
        if (remaining.length > 0) this.selectSession(remaining[0])
        else { this.currentSession.set(null); this.messages.set([]); this.toolEvents.set([]) }
      }
    })
  }

  renameSession(session: Session) {
    const name = prompt('Session name:', session.name)
    if (name && name !== session.name) {
      this.api.renameSession(session.id, name).subscribe((updated) => {
        this.sessions.update((list) => list.map((s) => (s.id === updated.id ? updated : s)))
        if (this.currentSession()?.id === updated.id) this.currentSession.set(updated)
      })
    }
  }

  send() {
    const text = this.input().trim()
    const session = this.currentSession()
    if (!text || !session || this.loading()) return

    this.input.set('')
    this.toolEvents.set([])

    const userMsg: Message = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    this.messages.update((m) => [...m, userMsg])
    this.loading.set(true)
    this.scrollDown()

    let assistantContent = ''
    this.api.streamChat(session.id, text).subscribe({
      next: (chunk) => {
        if (chunk.type === 'text' && chunk.content) {
          assistantContent += chunk.content
          const lastMsg = this.messages()[this.messages().length - 1]
          if (lastMsg?.role === 'assistant') {
            this.messages.update((m) => {
              const copy = [...m]
              copy[copy.length - 1] = { ...copy[copy.length - 1], content: assistantContent }
              return copy
            })
          } else {
            this.messages.update((m) => [...m, {
              id: crypto.randomUUID(),
              sessionId: session.id,
              role: 'assistant' as const,
              content: assistantContent,
              createdAt: new Date().toISOString(),
            }])
          }
          this.scrollDown()
        }

        if (chunk.type === 'tool_start') {
          this.toolEvents.update((e) => [...e, {
            id: crypto.randomUUID(),
            type: 'tool_start',
            toolName: chunk.toolName || '',
            toolArgs: chunk.toolArgs,
            expanded: false,
          }])
        }
        if (chunk.type === 'tool_end') {
          this.toolEvents.update((e) => {
            const copy = [...e]
            for (let i = copy.length - 1; i >= 0; i--)
              if (copy[i].type === 'tool_start' && copy[i].toolName === chunk.toolName)
                { copy[i] = { ...copy[i], type: 'tool_end', toolResult: chunk.toolResult }; break }
            return copy
          })
        }
        if (chunk.type === 'tool_error') {
          this.toolEvents.update((e) => {
            const copy = [...e]
            for (let i = copy.length - 1; i >= 0; i--)
              if (copy[i].type === 'tool_start' && copy[i].toolName === chunk.toolName)
                { copy[i] = { ...copy[i], type: 'tool_error', error: chunk.error }; break }
            return copy
          })
        }
        if (chunk.type === 'done') { this.loading.set(false); this.loadSessions() }
        if (chunk.type === 'error') { console.error(chunk.error); this.loading.set(false) }
      },
      error: () => { this.loading.set(false) },
    })
  }

  scrollDown() {
    setTimeout(() => {
      const el = this.chatContainer()?.nativeElement
      if (el) el.scrollTop = el.scrollHeight
    }, 30)
  }

  toggleToolEvent(id: string) {
    this.toolEvents.update((e) => e.map((ev) => ev.id === id ? { ...ev, expanded: !ev.expanded } : ev))
  }

  formatDate(date: string) {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
}
