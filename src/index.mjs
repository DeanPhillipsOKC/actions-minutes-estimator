// Estimate a repo's GitHub Actions minutes for the current month from its run list.
// A repo token can't read the billing page, so each run that wasn't skipped counts its wall time
// rounded up to a whole minute. Per-run wall time is not per-job billing (see README > Known error).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const DEFAULT_MONTHLY_MINUTES = 3000
export const STOP_SHARE = 0.9
// GitHub's run list returns at most 1,000 runs for a `created` filter, however many pages are asked for.
export const LIST_CAP = 1000

const DAY_MS = 24 * 60 * 60 * 1000
const RUN_FIELDS = '{total: .total_count, runs: [.workflow_runs[] | {conclusion, run_started_at, updated_at}]}'
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')
const utcDay = (now = new Date()) => now.toISOString().slice(0, 10)

// A full page of runs is large even when projected, and execFileSync's default buffer is 1 MiB.
const runGh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })

export function monthlyMinutesFromEnv(value = process.env.ACTIONS_MINUTES_PER_MONTH) {
  const n = Number((value ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MONTHLY_MINUTES
}

// Pure: the estimated billed minutes for these runs (the REST shape: conclusion, run_started_at,
// updated_at). A skipped run used no runner. A run that started counts its wall time rounded up
// to a whole minute, at least 1, the way GitHub rounds each job.
export function estimateRunMinutes(runs) {
  let total = 0
  for (const run of runs) {
    if (run.conclusion === 'skipped' || !run.run_started_at || !run.updated_at) continue
    const ms = Date.parse(run.updated_at) - Date.parse(run.run_started_at)
    total += Math.max(1, Math.ceil(ms / 60000))
  }
  return total
}

// Runs created in [fromMs, toMs]. A range whose total is over the list cap is split in half (by the
// second) until every part fits, and each part is paged to its end. `repo` is "owner/name"; the
// default "{owner}/{repo}" is filled in by `gh` from the current checkout.
export function runsCreatedBetween(fromMs, toMs, { gh = runGh, repo = '{owner}/{repo}' } = {}) {
  const range = `${iso(fromMs)}..${iso(toMs)}`
  const page = (n) => JSON.parse(gh(['api', `repos/${repo}/actions/runs?per_page=100&page=${n}&created=${range}`, '--jq', RUN_FIELDS]) || '{}')
  const first = page(1)
  const total = first.total ?? 0
  if (total > LIST_CAP && toMs - fromMs >= 2000) {
    const mid = fromMs + Math.floor((toMs - fromMs) / 2000) * 1000
    return [...runsCreatedBetween(fromMs, mid, { gh, repo }), ...runsCreatedBetween(mid + 1000, toMs, { gh, repo })]
  }
  const runs = [...(first.runs ?? [])]
  for (let n = 2; runs.length < Math.min(total, LIST_CAP) && n <= LIST_CAP / 100; n++) {
    const next = page(n).runs ?? []
    if (next.length === 0) break
    runs.push(...next)
  }
  return runs
}

function readLedger(path) {
  if (!path || !existsSync(path)) return null
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    return typeof ledger.month === 'string' && typeof ledger.through === 'string' && Number.isInteger(ledger.minutes) ? ledger : null
  } catch {
    return null
  }
}

// This month's estimated minutes, from 00:00 UTC on the 1st to now. Listing runs is slow, so with a
// `ledger` file the days that are over are counted once and kept: { month, through, minutes } covers
// runs created from the 1st to the end of `through`. A day counts as over two days later, when
// nothing started on it can still be running; yesterday and today are always read fresh. Keep the
// ledger between runs with actions/cache.
export function minutesThisMonth({ gh = runGh, repo, now = new Date(), ledger = null } = {}) {
  const month = utcDay(now).slice(0, 7)
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const yesterday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS
  const nowMs = Math.floor(now.getTime() / 1000) * 1000

  const saved = readLedger(ledger)
  const kept = saved && saved.month === month && saved.through >= `${month}-01` ? saved : null
  let closed = kept ? kept.minutes : 0
  const nextStart = kept ? Date.parse(`${kept.through}T00:00:00Z`) + DAY_MS : monthStart
  const closedEnd = yesterday - 1000
  if (nextStart <= closedEnd) {
    closed += estimateRunMinutes(runsCreatedBetween(nextStart, closedEnd, { gh, repo }))
    if (ledger) writeFileSync(ledger, `${JSON.stringify({ month, through: utcDay(new Date(closedEnd)), minutes: closed })}\n`)
  }
  return closed + estimateRunMinutes(runsCreatedBetween(Math.max(monthStart, yesterday), nowMs, { gh, repo }))
}

// Pure: where the month's minutes stand. `pace` is the even share of the allowance up to the end of
// today. Level is "full" (within pace), "half" (ahead of pace), or "stop" (at 90% of the allowance).
// With a `base` (for example a daily run cap), `cap` is what the level allows of it.
export function minutesGuard({ used, monthly = DEFAULT_MONTHLY_MINUTES, base = 0, now = new Date() }) {
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const pace = Math.round((monthly * now.getUTCDate()) / days)
  const stopAt = Math.floor(monthly * STOP_SHARE)
  if (used >= stopAt) {
    return { level: 'stop', cap: 0, pace, reason: `${used} of ${monthly} minutes used, at or past ${stopAt} (90%)` }
  }
  if (used > pace) {
    return { level: 'half', cap: Math.floor(base / 2), pace, reason: `${used} minutes used, ahead of the ${pace} an even pace allows by today` }
  }
  return { level: 'full', cap: base, pace, reason: `${used} minutes used, within the ${pace} an even pace allows by today` }
}

// Estimate and guard in one call.
export function estimate({ monthly = monthlyMinutesFromEnv(), base = 0, ...options } = {}) {
  const used = minutesThisMonth(options)
  return { used, monthly, ...minutesGuard({ used, monthly, base, now: options.now }) }
}
