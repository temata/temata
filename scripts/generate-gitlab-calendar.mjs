import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_URL = 'https://forge.bposeats.com/users/therese.mata/calendar.json'
const OUTPUT_PATH = process.env.GITLAB_CALENDAR_OUTPUT ?? 'assets/gitlab-contributions.svg'
const DARK_OUTPUT_PATH =
  process.env.GITLAB_CALENDAR_DARK_OUTPUT ?? 'assets/gitlab-contributions-dark.svg'
const SOURCE_URL = process.env.GITLAB_CALENDAR_URL ?? DEFAULT_URL
const SOURCE_FILE = process.env.GITLAB_CALENDAR_SOURCE_FILE
const PERIOD_DAYS = Number.parseInt(process.env.GITLAB_CALENDAR_DAYS ?? '371', 10)

const DAY_MS = 24 * 60 * 60 * 1000
const CELL_SIZE = 10
const CELL_GAP = 3
const CELL_STEP = CELL_SIZE + CELL_GAP
const LEFT_PAD = 34
const TOP_PAD = 24
const BOTTOM_PAD = 24

const THEMES = {
  light: {
    colors: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    textColor: '#57606a',
    frameFill: null,
    frameStroke: null,
  },
  dark: {
    colors: ['#263040', '#0e4429', '#006d32', '#26a641', '#39d353'],
    textColor: '#c9d1d9',
    frameFill: null,
    frameStroke: null,
  },
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS)
}

function formatPhtDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(date)

  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  const year = parts.find((part) => part.type === 'year')?.value

  return `${month} ${day} ${year}`
}

function extractCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
  }

  if (value && typeof value === 'object') {
    const keys = ['count', 'contributions', 'value', 'total']
    for (const key of keys) {
      if (key in value) {
        return extractCount(value[key])
      }
    }
  }

  return 0
}

function normalizeCalendar(raw) {
  const contributions = new Map()

  const add = (dateKey, value) => {
    if (typeof dateKey !== 'string' || !DATE_PATTERN.test(dateKey)) {
      return
    }

    contributions.set(dateKey, extractCount(value))
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2) {
        add(String(item[0]), item[1])
        continue
      }

      if (item && typeof item === 'object') {
        const dateKey = item.date ?? item.day ?? item.day_string ?? item.created_at?.slice?.(0, 10)
        if (dateKey) {
          add(String(dateKey), item)
        }
      }
    }

    return contributions
  }

  if (!raw || typeof raw !== 'object') {
    return contributions
  }

  const source = raw.contributions && typeof raw.contributions === 'object' ? raw.contributions : raw
  for (const [dateKey, value] of Object.entries(source)) {
    add(dateKey, value)
  }

  return contributions
}

async function fetchCalendarData() {
  const errors = []

  if (SOURCE_FILE) {
    try {
      const fileData = await readFile(SOURCE_FILE, 'utf8')
      return {
        json: JSON.parse(fileData),
        label: `file:${SOURCE_FILE}`,
      }
    } catch (error) {
      errors.push(`file load failed (${SOURCE_FILE}): ${error.message}`)
    }
  }

  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        'User-Agent': 'gitlab-calendar-generator',
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return {
      json: await response.json(),
      label: SOURCE_URL,
    }
  } catch (error) {
    errors.push(`network fetch failed (${SOURCE_URL}): ${error.message}`)
  }

  return {
    json: {},
    label: 'unavailable',
    error: errors.join('; '),
  }
}

function computeLevels(values) {
  const positives = values.filter((value) => value > 0)
  if (positives.length === 0) {
    return {
      max: 0,
      levelFor: () => 0,
    }
  }

  const max = Math.max(...positives)
  const t1 = Math.max(1, Math.ceil(max * 0.25))
  const t2 = Math.max(t1 + 1, Math.ceil(max * 0.5))
  const t3 = Math.max(t2 + 1, Math.ceil(max * 0.75))

  return {
    max,
    levelFor: (value) => {
      if (value <= 0) return 0
      if (value < t1) return 1
      if (value < t2) return 2
      if (value < t3) return 3
      return 4
    },
  }
}

function renderSvg(contributionMap, sourceLabel, themeName = 'light') {
  const theme = THEMES[themeName] ?? THEMES.light
  const today = new Date()
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const start = addDays(end, -(Math.max(PERIOD_DAYS, 70) - 1))
  const alignedStart = addDays(start, -start.getUTCDay())

  const days = []
  for (let day = alignedStart; day <= end; day = addDays(day, 1)) {
    days.push(new Date(day))
  }

  const weekCount = Math.ceil(days.length / 7)
  const width = LEFT_PAD + weekCount * CELL_STEP + 12
  const height = TOP_PAD + 7 * CELL_STEP + BOTTOM_PAD

  const counts = days.map((day) => contributionMap.get(isoDate(day)) ?? 0)
  const total = counts.reduce((sum, value) => sum + value, 0)
  const updatedDate = formatPhtDate()
  const levels = computeLevels(counts)

  const rects = days
    .map((day, index) => {
      const week = Math.floor(index / 7)
      const dow = day.getUTCDay()
      const x = LEFT_PAD + week * CELL_STEP
      const y = TOP_PAD + dow * CELL_STEP
      const dateKey = isoDate(day)
      const count = contributionMap.get(dateKey) ?? 0
      const color = theme.colors[levels.levelFor(count)]
      const title = `${dateKey}: ${count} contribution${count === 1 ? '' : 's'}`

      return [
        `<rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2" ry="2" fill="${color}">`,
        `<title>${title}</title>`,
        '</rect>',
      ].join('')
    })
    .join('')

  const monthLabels = []
  let lastMonth = -1
  let lastLabelX = -100

  for (let week = 0; week < weekCount; week++) {
    const date = addDays(alignedStart, week * 7)
    const month = date.getUTCMonth()

    if (month !== lastMonth) {
      const x = LEFT_PAD + week * CELL_STEP
      if (x - lastLabelX >= 28) {
        const label = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
        monthLabels.push(`<text x="${x}" y="14" class="month">${label}</text>`)
        lastLabelX = x
      }
      lastMonth = month
    }
  }

  const dayLabels = [
    `<text x="2" y="${TOP_PAD + 1 * CELL_STEP + 8}" class="day">Mon</text>`,
    `<text x="2" y="${TOP_PAD + 3 * CELL_STEP + 8}" class="day">Wed</text>`,
    `<text x="2" y="${TOP_PAD + 5 * CELL_STEP + 8}" class="day">Fri</text>`,
  ].join('')

  const sourceText = sourceLabel.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitLab contributions heatmap">`,
    '<style>',
    `text { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; fill: ${theme.textColor}; }`,
    '.month { font-size: 10px; }',
    '.day { font-size: 9px; }',
    '.summary { font-size: 10px; }',
    '</style>',
    theme.frameFill
      ? `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" ry="8" fill="${theme.frameFill}" stroke="${theme.frameStroke}"/>`
      : '',
    `${monthLabels.join('')}`,
    dayLabels,
    rects,
    `<text x="0" y="${height - 8}" class="summary">${total} contributions in the last ${weekCount} weeks (updated ${updatedDate} PHT)</text>`,
    `<text x="${width - 6}" y="${height - 8}" text-anchor="end" class="summary">source: ${sourceText}</text>`,
    '</svg>',
  ].join('')
}

async function main() {
  const { json, label, error } = await fetchCalendarData()
  const map = normalizeCalendar(json)
  const svg = renderSvg(map, label, 'light')
  const darkSvg = renderSvg(map, label, 'dark')

  const outputDir = path.dirname(OUTPUT_PATH)
  await mkdir(outputDir, { recursive: true })
  await writeFile(OUTPUT_PATH, `${svg}\n`, 'utf8')
  await writeFile(DARK_OUTPUT_PATH, `${darkSvg}\n`, 'utf8')

  if (error) {
    console.warn(`Calendar data fallback used: ${error}`) // eslint-disable-line no-console
  }
  console.log(
    `Wrote ${OUTPUT_PATH} and ${DARK_OUTPUT_PATH} with ${map.size} day entries`,
  ) // eslint-disable-line no-console
}

main().catch((error) => {
  console.error(error) // eslint-disable-line no-console
  process.exit(1)
})
