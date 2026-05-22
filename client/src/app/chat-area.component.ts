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

  parseWeatherResult(result: string): WeatherData | null {
    if (!result) return null
    const lines = result.split('\n').filter(l => l.trim())
    const locationMatch = lines[0]?.match(/^Weather for (.+)/)
    if (!locationMatch) return null

    const nowLine = lines.find(l => l.startsWith('Now:'))
    const currentTemp = nowLine?.match(/Now:\s*([\d.-]+)°C/)?.at(1) || ''
    const feelsLike = nowLine?.match(/feels like ([\d.-]+)°C/)?.at(1) || ''
    const condition = nowLine?.match(/°C[,\s]+\s*(.+)$/)?.at(1)?.trim() || ''

    const detailLine = lines.find(l => l.startsWith('Humidity:'))
    const humidity = detailLine?.match(/Humidity:\s*([\d.]+%)/)?.at(1) || ''
    const wind = detailLine?.match(/Wind:\s*([\d.]+ km\/h)/)?.at(1) || ''
    const pressure = detailLine?.match(/Pressure:\s*([\d.]+ hPa)/)?.at(1) || ''
    const uv = detailLine?.match(/UV:\s*([\d.]+)/)?.at(1) || ''

    const forecast: WeatherForecast[] = []
    for (const line of lines) {
      const fMatch = line.match(/^(\w[\w\s]*?):\s*([\d.-]+)\u2013([\d.-]+)°C,\s*(.+)$/)
      if (fMatch && !line.startsWith('Now:')) {
        forecast.push({ day: fMatch[1].trim(), min: fMatch[2], max: fMatch[3], condition: fMatch[4].trim() })
      }
    }

    return { city: locationMatch[1].trim(), currentTemp, feelsLike, condition, humidity, wind, pressure, uv, forecast }
  }
}
