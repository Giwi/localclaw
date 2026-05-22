import { Component, Input } from '@angular/core'

export interface WeatherForecast {
  day: string
  min: string
  max: string
  condition: string
}

export interface WeatherData {
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
  selector: 'app-weather-widget',
  imports: [],
  templateUrl: './weather-widget.component.html',
})
export class WeatherWidgetComponent {
  @Input({ required: true }) data!: WeatherData

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
}
