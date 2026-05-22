import { Component, Input, output, viewChild, ElementRef, type SimpleChanges, type OnChanges } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { JsonPipe, AsyncPipe } from '@angular/common'
import { MarkdownPipe } from './markdown.pipe'
import { type Session, type Message, type ToolEvent } from './chat.service'

interface WeatherForecast {
  day: string
  min: string
  max: string
  condition: string
}

interface WeatherData {
  city: string
  currentTemp: string
  feelsLike: string
  condition: string
  humidity: string
  wind: string
  pressure: string
  uv: string
  forecast: WeatherForecast[]
}

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
  openTasksPage = output<void>()
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

  // ── Weather widget ──

  weatherEmoji(condition: string): string {
    const c = condition.toLowerCase()
    if (c.includes('clear') || c.includes('sunny')) return '\u2600\uFE0F'
    if (c.includes('mainly clear')) return '\uD83C\uDF24\uFE0F'
    if (c.includes('partly cloudy')) return '\u26C5'
    if (c.includes('overcast')) return '\u2601\uFE0F'
    if (c.includes('fog')) return '\uD83C\uDF2B\uFE0F'
    if (c.includes('drizzle')) return '\uD83C\uDF26\uFE0F'
    if (c.includes('rain shower')) return '\uD83C\uDF27\uFE0F'
    if (c.includes('rain') || c.includes('rain,')) return '\uD83C\uDF27\uFE0F'
    if (c.includes('freezing')) return '\uD83C\uDF27\uFE0F'
    if (c.includes('snow')) return '\u2744\uFE0F'
    if (c.includes('thunderstorm') || c.includes('hail')) return '\u26C8\uFE0F'
    return '\uD83C\uDF21\uFE0F'
  }

  getMessageWeather(msg: Message): WeatherData | null {
    if (!msg.toolResults) return null
    try {
      const results = JSON.parse(msg.toolResults) as { toolName: string; toolResult: string; widget?: { type: string; data: Record<string, unknown> } }[]
      const entry = results.find(r => r.toolName === 'weather' && r.widget?.type === 'weather')
      if (!entry?.widget) return null
      return this.widgetToWeatherData(entry.widget.data)
    } catch {
      return null
    }
  }

  private widgetToWeatherData(data: Record<string, unknown>): WeatherData | null {
    const forecast = (data['forecast'] as any[] || []).map((f: any) => ({
      day: String(f.day ?? ''),
      min: String(f.min ?? ''),
      max: String(f.max ?? ''),
      condition: String(f.condition ?? ''),
    }))
    return {
      city: String(data['city'] ?? ''),
      currentTemp: String(data['currentTemp'] ?? ''),
      feelsLike: String(data['feelsLike'] ?? ''),
      condition: String(data['condition'] ?? ''),
      humidity: String(data['humidity'] ?? ''),
      wind: String(data['wind'] ?? ''),
      pressure: String(data['pressure'] ?? ''),
      uv: String(data['uv'] ?? ''),
      forecast,
    }
  }

}
