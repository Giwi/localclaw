import { Component, OnInit, inject, signal, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { ChatService, type Session, type Message, type BackgroundTask, type ToolEvent } from './chat.service'
import { SidebarComponent } from './sidebar.component'
import { ChatAreaComponent } from './chat-area.component'

export interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

@Component({
  selector: 'app-root',
  imports: [SidebarComponent, ChatAreaComponent],
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  private api = inject(ChatService)

  sessions = signal<Session[]>([])
  messages = signal<Message[]>([])
  toolEvents = signal<ToolEvent[]>([])
  statusMsg = signal('')
  currentSession = signal<Session | null>(null)
  input = signal('')
  loading = signal(false)
  currentTheme = signal('light')
  sidebarOpen = signal(true)
  sidebarView = signal<'sessions' | 'tasks'>('sessions')
  editingMsg = signal<string | null>(null)
  toasts = signal<Toast[]>([])
  renamingId = signal<string | null>(null)
  renameInput = signal('')
  selectedSessionIndex = signal(0)
  backgroundTasks = signal<BackgroundTask[]>([])
  loadingTasks = signal(false)
  dragOver = signal(false)

  private toastTimers: Record<string, ReturnType<typeof setTimeout>> = {}
  private chatSubscription: Subscription | null = null
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null

  ngOnInit() {
    const saved = localStorage.getItem('localclaw-theme')
    if (saved === 'light' || saved === 'dark') {
      this.currentTheme.set(saved)
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      this.currentTheme.set('dark')
    }
    this.applyTheme()
    this.loadSessions()
  }

  ngOnDestroy() {
    this.chatSubscription?.unsubscribe()
    if (this.loadingTimeout) clearTimeout(this.loadingTimeout)
  }

  showToast(message: string, type: Toast['type'] = 'info', duration = 4000): string {
    const id = crypto.randomUUID()
    this.toasts.update((t) => [...t, { id, message, type }])
    const timer = setTimeout(() => this.removeToast(id), duration)
    this.toastTimers[id] = timer
    return id
  }

  removeToast(id: string) {
    if (this.toastTimers[id]) { clearTimeout(this.toastTimers[id]); delete this.toastTimers[id] }
    this.toasts.update((t) => t.filter((x) => x.id !== id))
  }

  toggleSidebar() {
    this.sidebarOpen.update((v) => !v)
  }

  hasKeys(obj: any): boolean {
    return obj != null && typeof obj === 'object' && Object.keys(obj).length > 0
  }

  toggleTheme() {
    const next = this.currentTheme() === 'light' ? 'dark' : 'light'
    this.currentTheme.set(next)
    this.applyTheme()
    localStorage.setItem('localclaw-theme', next)
  }

  private reconstructToolEvents(msgs: Message[]) {
    const events: ToolEvent[] = []
    for (const msg of msgs) {
      if (msg.toolResults) {
        try {
          const results = JSON.parse(msg.toolResults) as { toolName: string; toolResult: string }[]
          for (const tr of results) {
            events.push({
              id: crypto.randomUUID(),
              type: 'tool_end',
              toolName: tr.toolName,
              expanded: false,
              toolResult: tr.toolResult,
            })
          }
        } catch { /* skip invalid JSON */ }
      }
    }
    this.toolEvents.set(events)
  }

  private applyTheme() {
    document.documentElement.setAttribute('data-theme', this.currentTheme())
  }

  loadSessions() {
    this.api.getSessions().subscribe({
      next: (s) => {
        this.sessions.set(s)
        if (s.length > 0 && !this.currentSession()) {
          this.selectSession(s[0])
        }
      },
      error: () => this.showToast('Failed to load sessions', 'error'),
    })
  }

  selectSession(session: Session) {
    this.chatSubscription?.unsubscribe()
    this.chatSubscription = null
    this.currentSession.set(session)
    this.toolEvents.set([])
    this.api.getMessages(session.id).subscribe({
      next: (msgs) => {
        this.messages.set(msgs)
        this.reconstructToolEvents(msgs)
        if (msgs.filter(m => m.role === 'assistant').length === 0) {
          this.api.getProactiveSummary(session.id).subscribe({
            next: (proactive) => {
              if (proactive?.content) {
                this.messages.update((m) => [...m, {
                  id: crypto.randomUUID(),
                  sessionId: session.id,
                  role: 'assistant',
                  content: proactive.content,
                  createdAt: new Date().toISOString(),
                }])
              }
            },
          })
        }
      },
      error: () => this.showToast('Failed to load messages', 'error'),
    })
    const idx = this.sessions().findIndex((s) => s.id === session.id)
    if (idx >= 0) this.selectedSessionIndex.set(idx)
  }

  newSession() {
    this.api.createSession().subscribe({
      next: (s) => {
        this.sessions.update((list) => [s, ...list])
        this.selectSession(s)
        this.showToast('Session created', 'success')
      },
      error: () => this.showToast('Failed to create session', 'error'),
    })
  }

  deleteCurrent(e?: Event) {
    e?.stopPropagation()
    const s = this.currentSession()
    if (!s) return
    this.api.deleteSession(s.id).subscribe({
      next: () => {
        this.sessions.update((list) => list.filter((x) => x.id !== s.id))
        this.showToast('Session deleted', 'info')
        const remaining = this.sessions()
        if (remaining.length > 0) {
          this.selectSession(remaining[0])
        } else {
          this.currentSession.set(null)
          this.messages.set([])
          this.toolEvents.set([])
        }
      },
      error: () => this.showToast('Failed to delete session', 'error'),
    })
  }

  deleteSession(e: Event, id: string) {
    e.stopPropagation()
    this.api.deleteSession(id).subscribe({
      next: () => {
        this.sessions.update((list) => list.filter((x) => x.id !== id))
        this.showToast('Session deleted', 'info')
        if (this.currentSession()?.id === id) {
          const remaining = this.sessions()
          if (remaining.length > 0) this.selectSession(remaining[0])
          else { this.currentSession.set(null); this.messages.set([]); this.toolEvents.set([]) }
        }
      },
      error: () => this.showToast('Failed to delete session', 'error'),
    })
  }

  startRename(session: Session) {
    this.renamingId.set(session.id)
    this.renameInput.set(session.name)
  }

  commitRename(session: Session) {
    const name = this.renameInput().trim()
    this.renamingId.set(null)
    if (name && name !== session.name) {
      this.api.renameSession(session.id, name).subscribe({
        next: (updated) => {
          this.sessions.update((list) => list.map((s) => (s.id === updated.id ? updated : s)))
          if (this.currentSession()?.id === updated.id) this.currentSession.set(updated)
          this.showToast('Session renamed', 'success')
        },
        error: () => this.showToast('Failed to rename session', 'error'),
      })
    }
  }

  cancelRename() {
    this.renamingId.set(null)
  }

  switchSidebarView(view: 'sessions' | 'tasks') {
    this.sidebarView.set(view)
    if (view === 'tasks') this.loadBackgroundTasks()
  }

  loadBackgroundTasks() {
    this.loadingTasks.set(true)
    this.api.getBackgroundTasks().subscribe({
      next: (tasks) => { this.backgroundTasks.set(tasks); this.loadingTasks.set(false) },
      error: () => { this.showToast('Failed to load tasks', 'error'); this.loadingTasks.set(false) },
    })
  }

  toggleTask(task: BackgroundTask) {
    this.api.toggleBackgroundTask(task.id, !task.enabled).subscribe({
      next: () => {
        this.backgroundTasks.update((list) => list.map((t) => t.id === task.id ? { ...t, enabled: !t.enabled } : t))
        this.showToast(`Task ${task.enabled ? 'paused' : 'resumed'}`, 'success')
      },
      error: () => this.showToast('Failed to toggle task', 'error'),
    })
  }

  runTask(id: string) {
    this.api.runBackgroundTask(id).subscribe({
      next: () => {
        this.showToast('Task triggered', 'success')
        this.loadBackgroundTasks()
      },
      error: () => this.showToast('Failed to run task', 'error'),
    })
  }

  deleteBgTask(e: Event, task: BackgroundTask) {
    e.stopPropagation()
    this.api.deleteBackgroundTask(task.id).subscribe({
      next: () => {
        this.backgroundTasks.update((list) => list.filter((t) => t.id !== task.id))
        this.showToast('Task deleted', 'info')
      },
      error: () => this.showToast('Failed to delete task', 'error'),
    })
  }

  formatSchedule(task: BackgroundTask): string {
    const s = task.schedule
    const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : '—'
    const last = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : 'never'
    return `${s} · next: ${next} · last: ${last}`
  }

  onSessionKeydown(_event: KeyboardEvent) {
    // Keyboard navigation handled in sidebar component
  }

  uploadFile(event: Event) {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    const session = this.currentSession()
    if (!file || !session) return
    this.api.uploadFile(session.id, file).subscribe({
      next: (msg) => {
        this.messages.update((m) => [...m, msg])
        this.showToast('File uploaded', 'success')
      },
      error: () => this.showToast('Failed to upload file', 'error'),
    })
    target.value = ''
  }

  uploadFileDirect(file: File) {
    const session = this.currentSession()
    if (!session) return
    this.api.uploadFile(session.id, file).subscribe({
      next: (msg) => {
        this.messages.update((m) => [...m, msg])
        this.showToast('File uploaded', 'success')
      },
      error: () => this.showToast('Failed to upload file', 'error'),
    })
  }

  editMessage(msg: Message) {
    this.editingMsg.set(msg.id)
    this.input.set(msg.content)
  }

  cancelEdit() {
    this.editingMsg.set(null)
    this.input.set('')
  }

  stopGeneration() {
    this.api.cancelChat()
    this.loading.set(false)
    this.statusMsg.set('')
    if (this.loadingTimeout) { clearTimeout(this.loadingTimeout); this.loadingTimeout = null }
  }

  send() {
    const text = this.input().trim()
    const session = this.currentSession()
    if (!text || !session || this.loading()) return

    // Optimistically rename "New Session" on first message
    if (session.name === 'New Session' && text.length > 10) {
      const shortName = text.length > 50 ? text.slice(0, 50) + '...' : text
      this.sessions.update((list) =>
        list.map((s) => (s.id === session.id ? { ...s, name: shortName } : s))
      )
      this.currentSession.update((s) => (s ? { ...s, name: shortName } : s))
    }

    const editId = this.editingMsg()
    this.input.set('')
    this.editingMsg.set(null)
    this.toolEvents.set([])
    this.chatSubscription?.unsubscribe()

    if (editId) {
      this.api.editMessage(session.id, editId, text).subscribe({
        next: () => {
          this.api.getMessages(session.id).subscribe((msgs) => this.messages.set(msgs))
        },
        error: () => this.showToast('Failed to edit message', 'error'),
      })
    } else {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      }
      this.messages.update((m) => [...m, userMsg])
    }

    this.loading.set(true)
    if (this.loadingTimeout) clearTimeout(this.loadingTimeout)
    this.loadingTimeout = setTimeout(() => {
      this.loading.set(false)
      this.chatSubscription = null
      this.api.cancelChat()
      this.showToast('Request timed out', 'error')
    }, 300_000)

    const done = () => {
      this.loading.set(false)
      this.statusMsg.set('')
      this.loadSessions()
      this.loadBackgroundTasks()
      this.chatSubscription = null
      this.api.cancelChat()
      if (this.loadingTimeout) { clearTimeout(this.loadingTimeout); this.loadingTimeout = null }
    }

    let assistantContent = ''
    this.chatSubscription = this.api.streamChat(session.id, text).subscribe({
      next: (chunk) => {
        if (this.currentSession()?.id !== session.id) return
        if (chunk.type === 'status' && chunk.content) {
          this.statusMsg.set(chunk.content)
        }

        if (chunk.type === 'text' && chunk.content) {
          this.statusMsg.set('')
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
        }

        if (chunk.type === 'tool_start') {
          this.toolEvents.update((e) => [...e, {
            id: chunk.toolRunId || crypto.randomUUID(),
            type: 'tool_start',
            toolName: chunk.toolName || '',
            toolArgs: chunk.toolArgs,
            expanded: false,
            content: '',
          }])
        }
        if (chunk.type === 'tool_chunk') {
          this.toolEvents.update((e) => {
            const copy = [...e]
            for (let i = copy.length - 1; i >= 0; i--) {
              const ev = copy[i]
              if (ev.id === chunk.toolRunId && (ev.type === 'tool_start' || ev.type === 'tool_chunk')) {
                copy[i] = { ...ev, type: 'tool_chunk', content: (ev.content || '') + (chunk.content || '') }
                break
              }
            }
            return copy
          })
        }
        if (chunk.type === 'tool_end') {
          this.toolEvents.update((e) => {
            const copy = [...e]
            for (let i = copy.length - 1; i >= 0; i--)
              if (copy[i].id === chunk.toolRunId && (copy[i].type === 'tool_start' || copy[i].type === 'tool_chunk'))
                { copy[i] = { ...copy[i], type: 'tool_end', toolResult: chunk.toolResult }; break }
            return copy
          })
        }
        if (chunk.type === 'tool_error') {
          this.toolEvents.update((e) => {
            const copy = [...e]
            for (let i = copy.length - 1; i >= 0; i--)
              if (copy[i].id === chunk.toolRunId && (copy[i].type === 'tool_start' || copy[i].type === 'tool_chunk'))
                { copy[i] = { ...copy[i], type: 'tool_error', error: chunk.error }; break }
            return copy
          })
        }
        if (chunk.type === 'done') { this.statusMsg.set(''); done() }
        if (chunk.type === 'error') { this.showToast(chunk.error || 'Chat error', 'error'); done() }
      },
      error: () => { this.showToast('Connection lost', 'error'); done() },
    })
  }

  toggleToolEvent(id: string) {
    this.toolEvents.update((e) => e.map((ev) => ev.id === id ? { ...ev, expanded: !ev.expanded } : ev))
  }

  async copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      this.showToast('Copied to clipboard', 'success')
    } catch {
      this.showToast('Failed to copy', 'error')
    }
  }
}
