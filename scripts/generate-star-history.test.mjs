import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  fetchStarCount,
  generateStarHistory,
  parseStarHistoryData,
  renderStarHistorySvg,
  updateDailySnapshots
} from './generate-star-history.mjs'

const temporaryDirectories = new Set()

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })))
})

test('committed Star History data matches the renamed repository', async () => {
  const data = JSON.parse(await readFile('assets/star-history-data.json', 'utf8'))

  assert.doesNotThrow(() => parseStarHistoryData(data, 'zszz3/AgentRecall'))
})

test('fetchStarCount reads only repository metadata', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ stargazers_count: 152 }), { status: 200 })
  }

  const count = await fetchStarCount({
    repository: 'zszz3/AgentRecall',
    token: 'test-token',
    fetchImpl
  })

  assert.equal(count, 152)
  assert.equal(requests[0].url, 'https://api.github.com/repos/zszz3/AgentRecall')
  assert.equal(requests[0].options.headers.accept, 'application/vnd.github+json')
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-token')
})

test('fetchStarCount reports metadata failures and invalid counts', async () => {
  await assert.rejects(
    fetchStarCount({
      repository: 'zszz3/AgentRecall',
      token: 'test-token',
      fetchImpl: async () => new Response('{"message":"blocked"}', { status: 403 })
    }),
    /GitHub repository metadata request failed \(403\).*blocked/
  )
  await assert.rejects(
    fetchStarCount({
      repository: 'zszz3/AgentRecall',
      token: 'test-token',
      fetchImpl: async () => new Response('{"stargazers_count":-1}', { status: 200 })
    }),
    /invalid stargazers_count/
  )
})

test('parseStarHistoryData validates repository, ordering, dates, and counts', () => {
  const valid = {
    repository: 'zszz3/AgentRecall',
    snapshots: [{ date: '2026-07-13', count: 151 }, { date: '2026-07-14', count: 152 }]
  }
  assert.deepEqual(parseStarHistoryData(valid, valid.repository), valid)
  assert.throws(() => parseStarHistoryData({ ...valid, repository: 'other/repo' }, valid.repository), /repository mismatch/)
  assert.throws(() => parseStarHistoryData({ ...valid, snapshots: [{ date: '2026-02-30', count: 1 }] }, valid.repository), /invalid date/)
  assert.throws(() => parseStarHistoryData({ ...valid, snapshots: [{ date: '2026-07-14', count: 1 }, { date: '2026-07-14', count: 2 }] }, valid.repository), /strictly increasing/)
  assert.throws(() => parseStarHistoryData({ ...valid, snapshots: [{ date: '2026-07-14', count: -1 }] }, valid.repository), /non-negative integer/)
})

test('updateDailySnapshots replaces today and fills missing UTC days', () => {
  assert.deepEqual(
    updateDailySnapshots([{ date: '2026-07-13', count: 151 }], '2026-07-16', 150),
    [
      { date: '2026-07-13', count: 151 },
      { date: '2026-07-14', count: 151 },
      { date: '2026-07-15', count: 151 },
      { date: '2026-07-16', count: 150 }
    ]
  )
  assert.deepEqual(
    updateDailySnapshots([{ date: '2026-07-14', count: 151 }], '2026-07-14', 152),
    [{ date: '2026-07-14', count: 152 }]
  )
})

test('generateStarHistory updates the snapshot and SVG together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'star-history-'))
  temporaryDirectories.add(directory)
  const dataPath = join(directory, 'star-history-data.json')
  const outputPath = join(directory, 'star-history.svg')
  await writeFile(dataPath, JSON.stringify({
    repository: 'zszz3/AgentRecall',
    snapshots: [{ date: '2026-07-13', count: 151 }]
  }))

  const changed = await generateStarHistory({
    repository: 'zszz3/AgentRecall',
    token: 'test-token',
    dataPath,
    outputPath,
    now: new Date('2026-07-14T08:00:00Z'),
    fetchImpl: async () => new Response(JSON.stringify({ stargazers_count: 152 }), { status: 200 })
  })

  assert.equal(changed, true)
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).snapshots.at(-1), { date: '2026-07-14', count: 152 })
  assert.match(await readFile(outputPath, 'utf8'), /reaching 152 stars/)
})

test('generateStarHistory is idempotent when today is unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'star-history-idempotent-'))
  temporaryDirectories.add(directory)
  const dataPath = join(directory, 'star-history-data.json')
  const outputPath = join(directory, 'star-history.svg')
  const data = {
    repository: 'zszz3/AgentRecall',
    snapshots: [{ date: '2026-07-14', count: 152 }]
  }
  const json = `${JSON.stringify(data, null, 2)}\n`
  const svg = renderStarHistorySvg({ repository: data.repository, series: data.snapshots })
  await writeFile(dataPath, json)
  await writeFile(outputPath, svg)

  const changed = await generateStarHistory({
    repository: data.repository,
    token: 'test-token',
    dataPath,
    outputPath,
    now: new Date('2026-07-14T23:59:59Z'),
    fetchImpl: async () => new Response(JSON.stringify({ stargazers_count: 152 }), { status: 200 })
  })

  assert.equal(changed, false)
  assert.equal(await readFile(dataPath, 'utf8'), json)
  assert.equal(await readFile(outputPath, 'utf8'), svg)
})

test('rendered description uses star count history rather than cumulative wording', () => {
  const svg = renderStarHistorySvg({
    repository: 'zszz3/AgentRecall',
    series: [{ date: '2026-07-13', count: 152 }, { date: '2026-07-14', count: 151 }]
  })
  assert.match(svg, /GitHub star count history/)
  assert.doesNotMatch(svg, /Cumulative GitHub stars/)
})

test('renderStarHistorySvg is deterministic and describes the final star count', () => {
  const input = {
    repository: 'zszz3/AgentRecall',
    series: [
      { date: '2026-06-01', count: 1 },
      { date: '2026-06-02', count: 1 },
      { date: '2026-06-03', count: 3 }
    ]
  }

  const first = renderStarHistorySvg(input)
  const second = renderStarHistorySvg(input)

  assert.equal(first, second)
  assert.match(first, /AgentRecall Star History/)
  assert.match(first, /reaching 3 stars/)
  assert.match(first, /Updated Jun 3, 2026/)
  assert.doesNotMatch(first, /NaN|undefined/)
})

test('scheduled workflow regenerates and commits the chart only when it changes', async () => {
  const workflow = await readFile('.github/workflows/update-star-history.yml', 'utf8')

  assert.match(workflow, /schedule:/)
  assert.match(workflow, /cron:\s*['"]7 \*\/3 \* \* \*['"]/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /contents:\s*write/)
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v4/)
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v4/)
  assert.match(workflow, /node-version:\s*22/)
  assert.match(workflow, /GITHUB_TOKEN:/)
  assert.match(workflow, /node scripts\/generate-star-history\.mjs/)
  assert.match(workflow, /git diff --quiet -- assets\/star-history-data\.json assets\/star-history\.svg/)
  assert.match(workflow, /git add assets\/star-history-data\.json assets\/star-history\.svg/)
  assert.doesNotMatch(workflow, /\/stargazers/)
  assert.match(workflow, /git push/)
})
