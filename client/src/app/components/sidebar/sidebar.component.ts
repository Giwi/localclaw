import { Component, Input, output, viewChild, ElementRef, type OnInit, type SimpleChanges, type OnChanges } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DatePipe } from '@angular/common'
import { type Session, type BackgroundTask } from '../../services/chat.service'

@Component({
  selector: 'app-sidebar',
  imports: [FormsModule, DatePipe],
  templateUrl: './sidebar.component.html',
})
export class SidebarComponent implements OnInit, OnChanges {
  @Input() sessions: Session[] = []
  @Input() currentSession: Session | null = null
  @Input() sidebarView: 'sessions' | 'tasks' = 'sessions'
  @Input() backgroundTasks: BackgroundTask[] = []
  @Input() loadingTasks = false
  @Input() renamingId: string | null = null
  @Input() renameInput = ''
  @Input() selectedSessionIndex = 0
  @Input() currentTheme = 'light'
  @Input() sidebarOpen = true

  newSession = output<void>()
  selectSession = output<Session>()
  deleteSession = output<{ event: Event; id: string }>()
  startRename = output<Session>()
  commitRename = output<Session>()
  cancelRename = output<void>()
  switchSidebarView = output<'sessions' | 'tasks'>()
  toggleTheme = output<void>()
  toggleTask = output<BackgroundTask>()
  runTask = output<string>()
  deleteBgTask = output<{ event: Event; task: BackgroundTask }>()
  onSessionKeydown = output<KeyboardEvent>()
  renameInputChange = output<string>()

  sessionListEl = viewChild<ElementRef>('sessionList')
  kbIndex = 0

  ngOnInit() {
    this.kbIndex = this.selectedSessionIndex
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['selectedSessionIndex']) {
      this.kbIndex = this.selectedSessionIndex
    }
  }

  onKeydown(event: KeyboardEvent) {
    const list = this.sessions
    if (list.length === 0) return
    let idx = this.kbIndex

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      idx = (idx + 1) % list.length
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      idx = (idx - 1 + list.length) % list.length
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.selectSession.emit(list[idx])
      return
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      const target = list[idx]
      if (target) this.deleteSession.emit({ event, id: target.id })
      return
    }
    this.kbIndex = idx
    const el = this.sessionListEl()?.nativeElement
    if (el) {
      const child = el.children[idx] as HTMLElement
      child?.focus()
    }
    this.onSessionKeydown.emit(event)
  }
}
