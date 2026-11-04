#!/usr/bin/env node
import { estimate, monthlyMinutesFromEnv } from '../src/index.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
if (args.includes('--help')) {
  console.log('Usage: actions-minutes-estimator [--repo owner/name] [--monthly N] [--ledger file] [--base N]\n\nPrints JSON: used, monthly, pace, level (full|half|stop), cap, reason.\nNeeds the gh CLI, signed in (GH_TOKEN works). --monthly defaults to ACTIONS_MINUTES_PER_MONTH, else 3000.')
  process.exit(0)
}
try {
  const result = estimate({
    repo: flag('repo'),
    monthly: flag('monthly') ? monthlyMinutesFromEnv(flag('monthly')) : monthlyMinutesFromEnv(),
    ledger: flag('ledger') ?? null,
    base: Number(flag('base') ?? 0),
  })
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(`actions-minutes-estimator: ${String(error.stderr ?? error.message).trim()}`)
  process.exit(1)
}
