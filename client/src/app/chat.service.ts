import { Injectable, inject, NgZone } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { Observable, Subject } from 'rxjs'

export interface Session {
  id: string
  name: string
  model: string
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export interface BackgroundTask {
  id: string
  sessionId: string
  name: string
  schedule: string
  toolName: string
  toolArgs: string
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastResult: string | null
  lastError: string | null
  createdAt: string
}

export interface ToolEvent {
  id: string
  type: 'tool_start' | 'tool_chunk' | 'tool_end' | 'tool_error'
  toolName: string
  expanded: boolean
  expandedMore?: boolean
  toolArgs?: Record<string, any>
  toolResult?: string
  content?: string
  error?: string
}

export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_chunk' | 'tool_end' | 'tool_error' | 'status' | 'done' | 'error'
  content?: string
  toolName?: string
  toolRunId?: string
  toolArgs?: Record<string, any>
  toolResult?: string
  error?: string
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient)
  private zone = inject(NgZone)

  private ws: WebSocket | null = null
  private wsSubject: Subject<StreamChunk> | null = null

  cancelChat() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    if (this.wsSubject) {
      this.wsSubject.complete()
      this.wsSubject = null
    }
  }

  getSessions() {
    return this.http.get<Session[]>('/api/sessions')
  }

  createSession(name?: string, model?: string) {
    return this.http.post<Session>('/api/sessions', { name, model })
  }

  getSession(id: string) {
    return this.http.get<Session>(`/api/sessions/${id}`)
  }

  getMessages(sessionId: string) {
    return this.http.get<Message[]>(`/api/sessions/${sessionId}/messages`)
  }

  deleteSession(id: string) {
    return this.http.delete(`/api/sessions/${id}`)
  }

  renameSession(id: string, name: string) {
    return this.http.patch<Session>(`/api/sessions/${id}`, { name })
  }

  editMessage(sessionId: string, msgId: string, content: string) {
    return this.http.patch<Message[]>(`/api/sessions/${sessionId}/messages/${msgId}`, { content })
  }

  getBackgroundTasks() {
    return this.http.get<BackgroundTask[]>('/api/background-tasks')
  }

  deleteBackgroundTask(id: string) {
    return this.http.delete(`/api/background-tasks/${id}`)
  }

  toggleBackgroundTask(id: string, enabled: boolean) {
    return this.http.patch(`/api/background-tasks/${id}`, { enabled })
  }

  uploadFile(sessionId: string, file: File): Observable<Message> {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<Message>(`/api/sessions/${sessionId}/upload`, fd)
  }

  streamChat(sessionId: string, message: string): Observable<StreamChunk> {
    this.cancelChat()

    const subject = new Subject<StreamChunk>()
    this.wsSubject = subject

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${location.host}/ws`

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'chat', sessionId, message }))
    }

    ws.onmessage = (event) => {
      try {
        const data: StreamChunk = JSON.parse(event.data)
        this.zone.run(() => subject.next(data))
        if (data.type === 'done' || data.type === 'error') {
          ws.close()
          this.ws = null
          this.zone.run(() => subject.complete())
          this.wsSubject = null
        }
      } catch { /* skip */ }
    }

    ws.onerror = () => {
      this.zone.run(() => {
        subject.error(new Error('WebSocket error'))
        this.ws = null
        this.wsSubject = null
      })
    }

    ws.onclose = () => {
      this.zone.run(() => {
        if (this.wsSubject === subject) {
          subject.complete()
          this.wsSubject = null
        }
        if (this.ws === ws) {
          this.ws = null
        }
      })
    }

    return subject.asObservable()
  }
}
