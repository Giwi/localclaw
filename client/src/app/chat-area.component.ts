import { Component, Input, output, viewChild, ElementRef, type SimpleChanges, type OnChanges } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { JsonPipe, AsyncPipe } from '@angular/common'
import { MarkdownPipe } from './markdown.pipe'
import { type Session, type Message, type ToolEvent } from './chat.service'

@Component({
  selector: 'app-chat-area',
  imports: [FormsModule, JsonPipe, AsyncPipe, MarkdownPipe],
  templateUrl: './chat-area.component.html',
})
export class ChatAreaComponent implements OnChanges {
  @Input() currentSession: Session | null = null
  @Input() messages: Message[] = []
  @Input() toolEvents: ToolEvent[] = []
  @Input() loading = false
  @Input() statusMsg = ''
  @Input() input = ''
  @Input() editingMsg: string | null = null
  @Input() dragOver = false
  @Input() sidebarOpen = true

  toggleSidebar = output<void>()
  sendMessage = output<string>()
  editMessage = output<Message>()
  cancelEdit = output<void>()
  stopGeneration = output<void>()
  startRename = output<Session>()
  deleteCurrent = output<void>()
  toggleToolEvent = output<string>()
  copyText = output<string>()
  uploadFile = output<Event>()
  dragOverChange = output<boolean>()
  dropFile = output<File>()
  newSession = output<void>()
  inputChange = output<string>()

  chatContainer = viewChild<ElementRef>('chatContainer')

  ngOnChanges(changes: SimpleChanges) {
    if (changes['messages'] || changes['toolEvents']) {
      setTimeout(() => this.scrollDown())
    }
  }

  scrollDown() {
    setTimeout(() => {
      const el = this.chatContainer()?.nativeElement
      if (el) el.scrollTop = el.scrollHeight
    }, 30)
  }

  formatDate(date: string) {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  truncateResult(text: string, maxLines = 8): string {
    const lines = text.split('\n')
    if (lines.length <= maxLines) return text
    return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`
  }

  hasMoreLines(text: string, maxLines = 8): boolean {
    return text.split('\n').length > maxLines
  }

  onDragOver(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    this.dragOverChange.emit(true)
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    this.dragOverChange.emit(false)
  }

  onDrop(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    this.dragOverChange.emit(false)
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    this.dropFile.emit(file)
  }
}
