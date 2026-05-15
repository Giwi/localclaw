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

export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_end' | 'tool_error' | 'done' | 'error'
  content?: string
  toolName?: string
  toolArgs?: Record<string, any>
  toolResult?: string
  error?: string
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient)
  private zone = inject(NgZone)

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

  streamChat(sessionId: string, message: string): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>()

    fetch(`/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }).then(async (res) => {
      const reader = res.body?.getReader()
      if (!reader) {
        this.zone.run(() => subject.error(new Error('No response body')))
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue
            try {
              const data: StreamChunk = JSON.parse(trimmed.slice(6))
              this.zone.run(() => subject.next(data))
            } catch { /* skip */ }
          }
        }
        this.zone.run(() => subject.complete())
      } catch (err) {
        this.zone.run(() => subject.error(err))
      }
    }).catch((err) => this.zone.run(() => subject.error(err)))

    return subject.asObservable()
  }
}
