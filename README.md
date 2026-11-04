# actions-minutes-estimator

Estimate this month's GitHub Actions minutes for a repo, and say whether you're on pace.

A repo token can't read GitHub's billing page, so a private repo has no easy way to budget its included minutes. This tool estimates them from the repo's run list instead. For October 2026 it came within 2% of the bill (2,421 estimated against about 2,384 billed).

It prints the minutes used, the even pace for today, and a guard level:

| Level | Meaning |
|---|---|
| `full` | Used minutes are within the even pace. |
| `half` | Ahead of the even pace. A `base` cap (such as runs per day) is halved. |
| `stop` | At 90% of the allowance. The last 10% is kept for CI and a release. |

## CLI

Needs Node 18+ and the [`gh` CLI](https://cli.github.com), signed in (`GH_TOKEN` works).

```sh
npx actions-minutes-estimator --repo owner/name --monthly 3000
# {"used":1180,"monthly":3000,"level":"full","cap":0,"pace":1400,"reason":"..."}
```

Options: `--repo owner/name` (default: the current checkout), `--monthly N` (default `ACTIONS_MINUTES_PER_MONTH`, else 3000), `--ledger file` (see below), `--base N` (a cap to scale by the level).

## GitHub Action

```yaml
- id: minutes
  uses: DeanPhillipsOKC/actions-minutes-estimator@v0
  with:
    monthly-minutes: 3000
- run: echo "${{ steps.minutes.outputs.level }}: ${{ steps.minutes.outputs.reason }}"
```

The token needs `actions: read`. Finished days are kept in `actions/cache`, so later runs read only yesterday and today.

## Library

```js
import { estimateRunMinutes, runsCreatedBetween, minutesThisMonth, minutesGuard } from 'actions-minutes-estimator'
```

`estimateRunMinutes(runs)` and `minutesGuard({ used, monthly, base, now })` are pure. `runsCreatedBetween` and `minutesThisMonth` call `gh`; pass `{ gh }` to supply your own runner.

## How the estimate works

- Each run that wasn't skipped counts its wall time (`updated_at` minus `run_started_at`), rounded up to a whole minute, at least 1.
- GitHub's run list returns at most 1,000 runs for a date-filtered query, however many pages you ask for, and a busy month has several thousand. A range over the cap is split in half until every part fits.
- A ledger file `{ month, through, minutes }` keeps days that are over (a day is over two days later, when nothing started on it can still be running), so a run reads only yesterday and today.
- The month runs from 00:00 UTC on the 1st.

## Known error

GitHub bills per job, each rounded up to a minute, but the run list gives one wall time per run. A run with parallel jobs is under-counted (jobs overlap), and a run with many short jobs is under-counted too, since each job's rounding is lost. Queue time and runner multipliers (macOS, Windows) aren't in the estimate. The October comparison above landed 2% high, but treat the figure as a budgeting aid, not the bill.

## License

MIT

## Releasing

1. Bump `version` in `package.json` and merge to `main`.
2. Actions > **Stage release on npm** > Run workflow. It runs the tests and stages the version with the
   stage-only `NPM_TOKEN`; nothing is public yet.
3. Approve the staged version on npmjs.com with 2FA, or run `npm stage approve <stage-id> --otp <code>`
   (`npm stage list` shows the id).
