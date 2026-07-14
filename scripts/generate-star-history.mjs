import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DAY_MS = 24 * 60 * 60 * 1000
const SVG_WIDTH = 900
const SVG_HEIGHT = 480
const PLOT = { left: 72, right: 840, top: 76, bottom: 400 }

function formatDate(dateKey) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${dateKey}T00:00:00Z`))
}

function formatAxisDate(dateKey) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${dateKey}T00:00:00Z`))
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function coordinate(value) {
  return Number(value.toFixed(1)).toString()
}

function niceStep(value) {
  if (value <= 1) return 1
  const exponent = 10 ** Math.floor(Math.log10(value))
  const fraction = value / exponent
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return niceFraction * exponent
}

function displayName(repository) {
  return repository
    .split('/').at(-1)
    .split('-')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join('-')
}

function repositoryParts(repository) {
  const [owner, repo, ...extra] = repository.split('/')
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`GITHUB_REPOSITORY must use owner/repo format, received: ${repository}`)
  }
  return { owner, repo }
}

function isUtcDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export async function fetchStarCount({ repository, token, fetchImpl = fetch }) {
  const { owner, repo } = repositoryParts(repository)
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to read repository metadata')
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'agent-session-search-star-history'
      }
    }
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub repository metadata request failed (${response.status}): ${body.slice(0, 300)}`)
  }

  let metadata
  try {
    metadata = await response.json()
  } catch (error) {
    throw new Error(`Invalid GitHub repository metadata response for ${repository}: response is not valid JSON`, { cause: error })
  }
  if (!Number.isInteger(metadata?.stargazers_count) || metadata.stargazers_count < 0) {
    throw new Error(`Invalid GitHub repository metadata response for ${repository}: invalid stargazers_count`)
  }
  return metadata.stargazers_count
}

export function parseStarHistoryData(value, repository) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Star History data: expected an object')
  }
  if (value.repository !== repository) {
    throw new Error(`Invalid Star History data: repository mismatch, expected ${repository}`)
  }
  if (!Array.isArray(value.snapshots)) {
    throw new Error('Invalid Star History data: snapshots must be an array')
  }

  let previousDate = null
  const snapshots = value.snapshots.map((snapshot, index) => {
    if (!snapshot || typeof snapshot !== 'object' || !isUtcDateKey(snapshot.date)) {
      throw new Error(`Invalid Star History data: snapshot ${index} has an invalid date`)
    }
    if (previousDate !== null && snapshot.date <= previousDate) {
      throw new Error('Invalid Star History data: snapshot dates must be strictly increasing')
    }
    if (!Number.isInteger(snapshot.count) || snapshot.count < 0) {
      throw new Error(`Invalid Star History data: snapshot ${index} count must be a non-negative integer`)
    }
    previousDate = snapshot.date
    return { date: snapshot.date, count: snapshot.count }
  })

  return { repository, snapshots }
}

export function updateDailySnapshots(snapshots, date, count) {
  if (!isUtcDateKey(date)) {
    throw new Error(`Invalid snapshot date: ${date}`)
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid snapshot count: ${count}`)
  }
  if (snapshots.length === 0) {
    return [{ date, count }]
  }

  const next = snapshots.map((snapshot) => ({ ...snapshot }))
  const last = next.at(-1)
  if (date < last.date) {
    throw new Error(`Snapshot date ${date} is earlier than existing history ending ${last.date}`)
  }
  if (date === last.date) {
    next[next.length - 1] = { date, count }
    return next
  }

  for (let timestamp = Date.parse(`${last.date}T00:00:00Z`) + DAY_MS; ; timestamp += DAY_MS) {
    const missingDate = new Date(timestamp).toISOString().slice(0, 10)
    if (missingDate >= date) break
    next.push({ date: missingDate, count: last.count })
  }
  next.push({ date, count })
  return next
}

export function renderStarHistorySvg({ repository, series }) {
  const projectName = displayName(repository)
  const finalPoint = series.at(-1)
  const finalCount = finalPoint?.count ?? 0
  const updatedLabel = finalPoint ? formatDate(finalPoint.date) : 'No stars yet'
  const description = finalPoint
    ? `GitHub star count history from ${formatDate(series[0].date)} to ${updatedLabel}, reaching ${finalCount} stars.`
    : 'No GitHub stars have been recorded yet.'

  const plotWidth = PLOT.right - PLOT.left
  const plotHeight = PLOT.bottom - PLOT.top
  const step = niceStep(Math.max(1, finalCount) / 6)
  const yMax = Math.max(step, Math.ceil(Math.max(1, finalCount) / step) * step)
  const xAt = (index) => series.length <= 1
    ? PLOT.right
    : PLOT.left + (index / (series.length - 1)) * plotWidth
  const yAt = (count) => PLOT.bottom - (count / yMax) * plotHeight

  const yTicks = []
  for (let value = 0; value <= yMax; value += step) {
    const y = yAt(value)
    yTicks.push({ value, y })
  }

  const xTickIndexes = series.length === 0
    ? []
    : [...new Set(Array.from({ length: Math.min(5, series.length) }, (_, index) =>
        Math.round(index * (series.length - 1) / Math.max(1, Math.min(5, series.length) - 1))))]
  const points = series.map((point, index) => `${coordinate(xAt(index))},${coordinate(yAt(point.count))}`).join(' ')
  const areaPath = series.length === 0
    ? ''
    : `M${points.replaceAll(' ', ' L')} L${coordinate(xAt(series.length - 1))},${PLOT.bottom} L${coordinate(xAt(0))},${PLOT.bottom} Z`

  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">
  <title id="title">${escapeXml(projectName)} Star History</title>
  <desc id="description">${escapeXml(description)}</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#54aeff" stop-opacity="0.36" />
      <stop offset="100%" stop-color="#54aeff" stop-opacity="0.03" />
    </linearGradient>
  </defs>

  <rect fill="#ffffff" width="900" height="480" rx="12" />
  <text fill="#1f2328" x="72" y="42" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" font-weight="600">Star History</text>
  <text fill="#57606a" x="840" y="42" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13">${finalPoint ? `Updated ${escapeXml(updatedLabel)}` : escapeXml(updatedLabel)}</text>

  <g fill="none" stroke="#d8dee4" stroke-width="1">
${yTicks.map(({ y }) => `    <path d="M${PLOT.left} ${coordinate(y)}H${PLOT.right}" />`).join('\n')}
  </g>

  <g fill="#57606a" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12">
${yTicks.map(({ value, y }) => `    <text x="58" y="${coordinate(y + 4)}" text-anchor="end">${value}</text>`).join('\n')}
${xTickIndexes.map((index) => `    <text x="${coordinate(xAt(index))}" y="429" text-anchor="middle">${escapeXml(formatAxisDate(series[index].date))}</text>`).join('\n')}
  </g>

${series.length === 0 ? '  <text fill="#57606a" x="456" y="240" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16">No stars yet</text>' : `  <path fill="url(#area)" d="${areaPath}" />
  <polyline fill="none" stroke="#0969da" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
  <circle fill="#0969da" stroke="#ffffff" cx="${coordinate(xAt(series.length - 1))}" cy="${coordinate(yAt(finalCount))}" r="5" stroke-width="2" />
  <text fill="#1f2328" x="${coordinate(xAt(series.length - 1) - 12)}" y="${coordinate(yAt(finalCount) - 9)}" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" font-weight="600">${finalCount}</text>`}
</svg>
`
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function generateStarHistory({
  repository,
  token,
  dataPath,
  outputPath,
  now = new Date(),
  fetchImpl = fetch
}) {
  const currentData = await readFile(dataPath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(currentData)
  } catch (error) {
    throw new Error(`Invalid Star History JSON at ${dataPath}`, { cause: error })
  }

  const data = parseStarHistoryData(parsed, repository)
  const count = await fetchStarCount({ repository, token, fetchImpl })
  const date = now.toISOString().slice(0, 10)
  const snapshots = updateDailySnapshots(data.snapshots, date, count)
  const nextData = { repository, snapshots }
  const nextJson = `${JSON.stringify(nextData, null, 2)}\n`
  const nextSvg = renderStarHistorySvg({ repository, series: snapshots })
  const currentSvg = await readOptional(outputPath)
  let changed = false

  if (currentData !== nextJson) {
    await mkdir(path.dirname(dataPath), { recursive: true })
    await writeFile(dataPath, nextJson, 'utf8')
    changed = true
  }
  if (currentSvg !== nextSvg) {
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, nextSvg, 'utf8')
    changed = true
  }
  return changed
}

export async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required')
  }

  const dataPath = path.resolve(process.env.STAR_HISTORY_DATA ?? fileURLToPath(new URL('../assets/star-history-data.json', import.meta.url)))
  const outputPath = path.resolve(process.env.STAR_HISTORY_OUTPUT ?? fileURLToPath(new URL('../assets/star-history.svg', import.meta.url)))
  const changed = await generateStarHistory({ repository, token, dataPath, outputPath })
  console.log(changed ? `Updated Star History artifacts: ${dataPath}, ${outputPath}` : 'Star History is unchanged.')
  return changed
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
