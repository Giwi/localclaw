import type { ToolModule } from '../types.js'

const UA = 'localclaw/0.1 (weather-tool)'
const WEATHER_CODES: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow fall', 73: 'Moderate snow fall', 75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
}

function fetchWithUA(url: string, timeout = 10000): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) })
}

function locName(r: { name: string; admin1?: string; country?: string }): string {
  const parts: string[] = [r.name]
  if (r.admin1 && r.admin1 !== r.name) parts.push(r.admin1)
  if (r.country && r.country !== r.name && r.country !== r.admin1) parts.push(r.country)
  return parts.join(', ')
}

async function geocode(location: string): Promise<{ lat: number; lon: number; name: string } | string> {
  const res = await fetchWithUA(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=en&format=json`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return `Geocoding API error ${res.status}${body ? ': ' + body.slice(0, 100) : ''}`
  }
  const data = await res.json()
  const results = data.results
  if (!results || results.length === 0) return `Location "${location}" not found.`
  const r = results[0]
  return { lat: r.latitude, lon: r.longitude, name: locName(r) }
}

export const weatherTool: ToolModule = {
  definition: {
    name: 'weather',
    description: 'Get current weather and forecast for any location. Uses Open-Meteo (free, no API key). Provide a city name or coordinates.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name (e.g. "Paris", "London", "Tokyo") or "lat,lon" coordinates' },
        days: { type: 'string', description: 'Forecast days: "current" for now, "today", or "3" for 3-day (default: current)' },
      },
      required: ['location'],
    },
  },
  execute: async (args, onChunk) => {
    const location = (args.location || '').trim()
    const days = (args.days || 'current').trim().toLowerCase()

    if (!location) return 'Please provide a "location" (city name or lat,lon).'

    onChunk?.(`Looking up "${location}"...`)

    let lat: number, lon: number, displayName: string

    const coords = location.match(/^(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)$/)
    if (coords) {
      lat = parseFloat(coords[1])
      lon = parseFloat(coords[2])
      displayName = `${lat}, ${lon}`
    } else {
      const geo = await geocode(location)
      if (typeof geo === 'string') return geo
      lat = geo.lat
      lon = geo.lon
      displayName = geo.name
    }

    onChunk?.(`Fetching weather for ${displayName}...`)

    const currentParams = 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,pressure_msl,uv_index'
    let url: string

    if (days === 'current' || days === 'today') {
      url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${currentParams}&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=${days === 'today' ? 1 : 1}`
    } else {
      const n = Math.min(Math.max(parseInt(days) || 3, 1), 7)
      url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${currentParams}&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max&timezone=auto&forecast_days=${n}`
    }

    try {
      const res = await fetchWithUA(url, 15000)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        if (res.status === 403) return `Weather API error: 403 — request blocked. The free Open-Meteo API may have rate-limited this IP. Try again in a few seconds.`
        return `Weather API error ${res.status}${body ? ': ' + body.slice(0, 100) : ''}`
      }
      const data = await res.json()

      let result = `Weather for ${displayName}\n`

      if (data.current) {
        const c = data.current
        const wCode = WEATHER_CODES[c.weather_code] || `Code ${c.weather_code}`
        result += `\nNow: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C), ${wCode}`
        result += `\nHumidity: ${c.relative_humidity_2m}% | Wind: ${c.wind_speed_10m} km/h`
        if (c.pressure_msl !== undefined && c.pressure_msl !== null) result += ` | Pressure: ${c.pressure_msl} hPa`
        if (c.uv_index !== undefined && c.uv_index !== null) result += ` | UV: ${c.uv_index}`
      }

      if (data.daily) {
        const d = data.daily
        result += `\n`
        for (let i = 0; i < d.time.length; i++) {
          const day = d.time[i] === new Date().toISOString().slice(0, 10) ? 'Today' : d.time[i]
          const wc = WEATHER_CODES[d.weather_code[i]] || `Code ${d.weather_code[i]}`
          result += `\n${day}: ${d.temperature_2m_min[i]}–${d.temperature_2m_max[i]}°C, ${wc}`
        }
      }

      return result
    } catch (err: unknown) {
      return `Weather fetch failed: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
