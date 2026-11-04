import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateRunMinutes, LIST_CAP, minutesGuard, minutesThisMonth, monthlyMinutesFromEnv, runsCreatedBetween } from '../src/index.mjs'

const run = (start, end, conclusion = 'success') => ({ conclusion, run_started_at: start, updated_at: end })

test('a run counts its wall time rounded up to a whole minute, and a skipped run counts nothing', () => {
  assert.equal(
    estimateRunMinutes([
      run('2026-11-02T10:00:00Z', '2026-11-02T10:00:20Z'),
      run('2026-11-02T10:00:00Z', '2026-11-02T10:03:01Z'),
      run('2026-11-02T10:00:00Z', '2026-11-02T10:00:01Z', 'skipped'),
      run('2026-11-02T10:00:00Z', '2026-11-02T10:02:00Z', 'failure'),
      { conclusion: null, run_started_at: null, updated_at: '2026-11-02T10:00:00Z' },
    ]),
    1 + 4 + 2,
  )
})

// A stubbed run list that behaves like GitHub's: `created=<from>..<to>` filters, pages of 100,
// `total_count` is the true count, but no query returns more than 1,000 runs. Each run is one minute.
function stubRuns(created) {
  const calls = []
  const gh = (args) => {
    const url = new URL(`https://x/${args[1]}`)
    const [from, to] = url.searchParams.get('created').split('..').map((t) => Date.parse(t))
    const page = Number(url.searchParams.get('page'))
    calls.push({ path: args[1], range: url.searchParams.get('created'), page, jq: args[3] })
    const all = created.filter((c) => Date.parse(c) >= from && Date.parse(c) <= to)
    const visible = all.slice(0, LIST_CAP)
    const runs = visible.slice((page - 1) * 100, page * 100).map((c) => run(c, new Date(Date.parse(c) + 60000).toISOString()))
    return JSON.stringify({ total: all.length, runs })
  }
  return { gh, calls }
}

const spread = (from, n, hours) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + Math.floor((i * hours * 3600000) / n)).toISOString())

test('a range over the 1,000-run list cap is split until every part fits, and every run counts', () => {
  const { gh, calls } = stubRuns(spread('2026-10-01T00:00:00Z', 2500, 24 * 12))
  const runs = runsCreatedBetween(Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-12T23:59:59Z'), { gh })
  assert.equal(runs.length, 2500)
  assert.equal(calls.some((c) => c.page > LIST_CAP / 100), false)
  assert.match(calls[0].jq, /\{conclusion, run_started_at, updated_at\}/)
})

test('the repo option picks which repository is read', () => {
  const { gh, calls } = stubRuns([])
  runsCreatedBetween(Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-02T00:00:00Z'), { gh, repo: 'me/proj' })
  assert.ok(calls[0].path.startsWith('repos/me/proj/actions/runs'))
})

test('the month is counted from 00:00 UTC on the 1st, and a busy month is not cut off at 1,000 runs', () => {
  const created = [...spread('2026-09-30T12:00:00Z', 50, 11), ...spread('2026-10-01T00:00:00Z', 2400, 24 * 20)]
  assert.equal(minutesThisMonth({ gh: stubRuns(created).gh, now: new Date('2026-10-21T00:00:00Z') }), 2400)
})

test('with a ledger, finished days are read once and kept; yesterday and today are read fresh', () => {
  const created = spread('2026-10-01T00:00:00Z', 1500, 24 * 15)
  const ledger = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'minutes-ledger.json')
  const now = new Date('2026-10-16T00:00:00Z')
  assert.equal(minutesThisMonth({ gh: stubRuns(created).gh, now, ledger }), 1500)
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')), { month: '2026-10', through: '2026-10-14', minutes: 1400 })
  const second = stubRuns(created)
  assert.equal(minutesThisMonth({ gh: second.gh, now, ledger }), 1500)
  assert.ok(second.calls.every((c) => c.range.startsWith('2026-10-15T00:00:00Z..')))
})

test("a ledger from last month or one that can't be read is ignored", () => {
  const created = spread('2026-11-01T00:00:00Z', 30, 24)
  const ledger = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'minutes-ledger.json')
  const now = new Date('2026-11-04T12:00:00Z')
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', through: '2026-10-31', minutes: 2400 }))
  assert.equal(minutesThisMonth({ gh: stubRuns(created).gh, now, ledger }), 30)
  writeFileSync(ledger, 'not json')
  assert.equal(minutesThisMonth({ gh: stubRuns(created).gh, now, ledger }), 30)
})

test('within an even pace keeps the full cap', () => {
  const g = minutesGuard({ used: 1500, monthly: 3000, base: 10, now: new Date('2026-11-15T12:00:00Z') })
  assert.equal(g.level, 'full')
  assert.equal(g.cap, 10)
  assert.equal(g.pace, 1500)
})

test('ahead of the pace halves the cap, rounded down', () => {
  const g = minutesGuard({ used: 1501, monthly: 3000, base: 9, now: new Date('2026-11-15T12:00:00Z') })
  assert.equal(g.level, 'half')
  assert.equal(g.cap, 4)
})

test('90% of the allowance stops, even late in the month', () => {
  const now = new Date('2026-11-30T23:00:00Z')
  const g = minutesGuard({ used: 2700, monthly: 3000, base: 10, now })
  assert.equal(g.level, 'stop')
  assert.equal(g.cap, 0)
  assert.equal(minutesGuard({ used: 2699, monthly: 3000, base: 10, now }).level, 'full')
})

test('the allowance comes from ACTIONS_MINUTES_PER_MONTH, else 3,000', () => {
  assert.equal(monthlyMinutesFromEnv('2000'), 2000)
  assert.equal(monthlyMinutesFromEnv(''), 3000)
  assert.equal(monthlyMinutesFromEnv('lots'), 3000)
  assert.equal(monthlyMinutesFromEnv('0'), 3000)
})
