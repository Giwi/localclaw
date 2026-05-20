import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()

function mockFetchOnce(data: any, ok = true) {
  mockFetch.mockResolvedValueOnce({
    ok,
    json: async () => data,
  })
}

function mockFetchCurrentWeather() {
  mockFetchOnce({
    current: {
      temperature_2m: 22,
      apparent_temperature: 20,
      weather_code: 0,
      relative_humidity_2m: 55,
      wind_speed_10m: 12,
      pressure_msl: 1013,
      uv_index: 5,
    },
    daily: {
      time: ['2026-05-17'],
      temperature_2m_max: [25],
      temperature_2m_min: [15],
      weather_code: [0],
    },
  })
}

describe('weatherTool', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  it('rejects empty location', async () => {
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '' })
    expect(result).toBe('Please provide a "location" (city name or lat,lon).')
  })

  it('uses coordinates path when location matches lat,lon pattern', async () => {
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566, 2.3522' })
    expect(result).toContain('Weather for 48.8566, 2.3522')
    expect(result).toContain('22°C')
    expect(result).toContain('Clear sky')
    expect(mockFetch).toHaveBeenCalledTimes(1) // no geocode call
  })

  it('parses semicolon-separated coordinates', async () => {
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566;2.3522' })
    expect(result).toContain('48.8566, 2.3522')
  })

  it('parses space-separated coordinates', async () => {
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566 2.3522' })
    expect(result).toContain('48.8566, 2.3522')
  })

  it('parses negative latitude', async () => {
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '-33.8688, 151.2093' })
    expect(result).toContain('-33.8688, 151.2093')
  })

  it('uses geocoding when location is a city name', async () => {
    mockFetchOnce({ results: [{ latitude: 48.85, longitude: 2.35, name: 'Paris', country: 'France' }] })
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: 'Paris' })
    expect(result).toContain('Weather for')
    expect(mockFetch).toHaveBeenCalledTimes(2) // geocode + weather
  })

  it('returns error when geocoding fails', async () => {
    mockFetchOnce({ ok: false, status: 429 }, false)
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: 'UnknownCityXYZ' })
    expect(result).toMatch(/geocoding api error/i)
  })

  it('returns error when location not found by geocoding', async () => {
    mockFetchOnce({ results: null })
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: 'Asdfghjkl12345' })
    expect(result).toMatch(/not found/i)
  })

  it('reports current weather with correct fields', async () => {
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566, 2.3522' })
    expect(result).toContain('22°C')
    expect(result).toContain('feels like 20°C')
    expect(result).toContain('Clear sky')
    expect(result).toContain('Humidity: 55%')
    expect(result).toContain('Wind: 12 km/h')
    expect(result).toContain('Pressure: 1013 hPa')
    expect(result).toContain('UV: 5')
  })

  it('includes daily forecast when days > 1', async () => {
    mockFetchOnce({
      current: { temperature_2m: 20, apparent_temperature: 18, weather_code: 1, relative_humidity_2m: 50, wind_speed_10m: 10 },
      daily: {
        time: ['2026-05-17', '2026-05-18'],
        temperature_2m_max: [24, 22],
        temperature_2m_min: [14, 13],
        weather_code: [1, 45],
      },
    })
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566, 2.3522', days: '3' })
    expect(result).toContain('Mainly clear')
    expect(result).toContain('Fog')
  })

  it('handles unknown weather codes', async () => {
    mockFetchOnce({
      current: { temperature_2m: 20, apparent_temperature: 18, weather_code: 999, relative_humidity_2m: 50, wind_speed_10m: 10 },
      daily: { time: ['2026-05-17'], temperature_2m_max: [22], temperature_2m_min: [15], weather_code: [999] },
    })
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566, 2.3522' })
    expect(result).toContain('Code 999')
  })

  it('returns error on weather API failure', async () => {
    mockFetchOnce({}, false)
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566, 2.3522' })
    expect(result).toMatch(/weather api error/i)
  })

  it('calls onChunk callback when provided', async () => {
    mockFetchCurrentWeather()
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const onChunk = vi.fn()
    await weatherTool.execute({ location: '48.8566, 2.3522' }, onChunk)
    expect(onChunk).toHaveBeenCalledTimes(2)
    expect(onChunk).toHaveBeenCalledWith(expect.stringContaining('Looking up'))
    expect(onChunk).toHaveBeenCalledWith(expect.stringContaining('Fetching weather'))
  })

  it('limits forecast days to max 7', async () => {
    mockFetchOnce({
      current: { temperature_2m: 20, apparent_temperature: 18, weather_code: 1, relative_humidity_2m: 50, wind_speed_10m: 10 },
      daily: {
        time: Array.from({ length: 7 }, (_, i) => `2026-05-${17 + i}`),
        temperature_2m_max: Array(7).fill(20),
        temperature_2m_min: Array(7).fill(10),
        weather_code: Array(7).fill(1),
      },
    })
    const { weatherTool } = await import('../src/tools/builtin/weather.js')
    const result = await weatherTool.execute({ location: '48.8566, 2.3522', days: '99' })
    expect(result).toContain('2026-05-23')
    expect(result).not.toContain('2026-05-24')
  })
})
