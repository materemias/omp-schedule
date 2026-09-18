# omp-schedule

Recurring scheduled tasks for [Oh My Pi](https://github.com/can1357/oh-my-pi)
agents. This OMP-native adaptation is based on
[`pungggi/pi-schedule`](https://github.com/pungggi/pi-schedule) v0.3.2 at
commit `1af98f0113636a4b2d7351c10af2d4e39091fcc1`.

Give the agent a way to schedule work like:

- security reviews
- package / artifact version checks
- status polls
- any other recurring prompt-driven task

## Install

Install the tagged release:

```bash
omp plugin install github:hanhan3344/omp-schedule#v0.3.2-omp.2
```

For a cryptographically fixed source snapshot, replace the tag with the full
commit SHA shown on the release page:

```bash
omp plugin install github:hanhan3344/omp-schedule#<full-commit-sha>
```

Verify the installation:

```bash
omp plugin list
omp plugin doctor
```

For local development only:

```bash
git clone https://github.com/hanhan3344/omp-schedule.git
omp plugin link ./omp-schedule
```

## How it works

| Piece | Behavior |
|-------|----------|
| **Tool** | `schedule` — create / list / cancel / enable / disable / run_now / history |
| **Kinds** | `prompt` (default) · `shell` · `notify` · `message` — what fires when due |
| **Storage** | Scoped: global `~/.omp/schedule/schedules.json`, project `.omp/schedule.json`, or session `~/.omp/schedule/sessions/<session-id-hash>.json` |
| **Syntax** | Intervals (`30m`, `2h`, `1d`) and daily wall-clock (`09:00`) |
| **Fire** | On OMP session start/switch when due; also while the session stays open (30s ticker) |
| **Skip** | If OMP was launched with an initial prompt (`omp "do X"`), due jobs are not checked on initial startup; later session switches still check |
| **Reliability** | Run ledger, single-flight locks, missed-window policy, privilege tiers, fire caps — see [docs/RELIABILITY.md](docs/RELIABILITY.md) |

Global and project stores are **daemon-ready**. Each job tracks `nextRunAt` and
`lastRunAt`, so a future headless runner can share those files. Session jobs
require the matching OMP session ID.

## Agent skill

The package ships a **`schedule` skill** (`skills/schedule/SKILL.md`) that
loads on-demand and teaches the agent *how to schedule well*: when to use
`kind` (prompt / shell / notify / message), `every` vs `dailyAt`, privilege
tier, shell `wakeOn`, global/project/session scope, the missed-window tradeoff,
and self-contained prompts.
The tool is self-describing for mechanics; the skill owns the patterns.

## Agent tool

```text
schedule
  action: create | list | cancel | enable | disable | run_now | history
  name?:          short label (create)
  kind?:          prompt | shell | notify | message   (default prompt)
  prompt?:        task / reminder text; shell follow-up instruction
  command?:       shell only — run via bash -lc
  wakeOn?:        shell only — always | failure | success | never
  successPrompt?: shell only — agent text on exit 0
  failurePrompt?: shell only — agent text on non-zero / killed
  timeoutMs?:     shell only — default 60000, max 600000
  once?:          one-shot relative delay ("10m" / "30s"), then terminate (xor every/dailyAt)
  maxRuns?:       max deliveries (ok+error) before auto-disable
  every?:         "30m" | "2h" | "1d"   (xor dailyAt/once)
  dailyAt?:       "09:00"               (xor every/once)
  scope?:         "global" | "project" | "session"  (default: session)
  missedWindow?:  "catch_up_one" | "skip"   (default catch_up_one)
  tier?:          "read_only" | "suggest" | "mutate"  (default read_only; shell→mutate)
  id?:            job id
  limit?:         history row count
```

The default scope is `session`. A create response always states the selected
scope, including when the tool chose the default.

Session jobs live in a separate file for the creating OMP session ID. Only that
same session can list, manage, inspect history, `run_now`, or automatically fire
them. Other sessions never fall back to the session file. Closing the owner
leaves its jobs dormant. Resuming it applies the existing `missedWindow` policy:
`catch_up_one` delivers one overdue slot, while `skip` discards stale work. New,
forked, branched, and handed-off sessions have different IDs. Session files
remain after crashes or deleted sessions. There is no heartbeat or automatic
garbage collection.

### Job kinds

| kind | What happens | Agent turn? |
|------|----------------|-------------|
| **prompt** (default) | Inject isolated task contract | yes |
| **shell** | `pi.exec("bash", ["-lc", command])`; optional wake via `wakeOn` | only if wake fires |
| **notify** | UI/console reminder | no |
| **message** | Session custom message (display only) | no |

Shell jobs always store `tier=mutate` (command runs outside the agent tool path). Prefer `wakeOn=failure` for CI polls so success is silent.

The calling session must have an active `bash` tool to create, change, or run
schedules. Without it, only `list` and `history` are allowed, and automatic due
checks do no work. This prevents read-only scouts from using scheduled commands
to bypass their tool restrictions. Delegate CLI investigations to a shell-capable
worker and execute them directly, not through the scheduler.

### Lifecycle: `once` and `maxRuns`

- **`once`** — fire one time after a relative delay (`once="10m"`, `once="30s"`), then auto-disable. Ideal for reminders and delayed follow-ups. `run_now` won't re-fire a terminated one-shot — recreate it.
- **`maxRuns`** — cap a recurring job to N deliveries (counts ok + error; skips/locks don't count). After the cap, the job auto-disables with `terminated: maxRuns`. Re-enabling clears the flag and resumes counting.

A terminated job is disabled and excluded from due scans. `list` shows `[off/terminated:once]` or `[…:maxRuns]`.

### Examples

```text
# Daily STATIC security review at 09:00, project-scoped, read-only.
# (Static = read/search only. A git-driven "recent changes" review would need
#  bash, which read_only blocks — use tier="mutate" for that.)
schedule action=create name="security-review"
  prompt="Review the code under src/ for security issues (injection, auth bypass, exposed secrets). Summarize findings with file:line. If none, say 'No findings'."
  dailyAt="09:00" scope="project" tier="read_only"

# Direct shell poll — no agent turn on green; wake only on failure.
schedule action=create name="ci-poll" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion'"
  wakeOn="failure"
  failurePrompt="Latest CI run failed. Inspect logs and propose or apply fixes."
  every="5m" missedWindow="skip"

# Human reminder (no model tokens).
schedule action=create name="stretch" kind="notify"
  prompt="Stand up and stretch." every="1h"

# One-shot reminder in 5 minutes, then done.
schedule action=create name="break" kind="notify"
  prompt="Eye break — look 20ft away for 20s." once="5m"

# Bounded CI poll — stop after 10 checks even if still failing.
schedule action=create name="deploy-watch" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion'"
  wakeOn="failure" failurePrompt="Deploy failed — investigate."
  every="5m" maxRuns=10 missedWindow="skip"

# Check package versions every day via an agent prompt that must use the shell.
schedule action=create name="pkg-versions"
  prompt="Run `npm outdated` for prod dependencies. Report only meaningful updates as current→latest with a one-line rationale. If nothing meaningful, reply 'No findings'."
  every="1d" tier="mutate" missedWindow="skip"

# List / history / force / cancel
schedule action=list
schedule action=history id=abc123def456
schedule action=run_now id=abc123def456
schedule action=cancel id=abc123def456
```

## Delivery rules

1. **Session start.** Load global and current project jobs. Load session jobs
   only from the file for the current OMP session ID, then process due jobs.
2. **Session switch** (`new` / `resume` / `fork` / `handoff`). Process due
   global and project jobs after OMP commits the switch, so a resumed transcript
   cannot overwrite the injected task. Process session jobs only when the
   switched-to session ID matches their file. New, forked, branched, and
   handed-off sessions cannot see jobs owned by another session.
3. **CLI initial prompt**: only on process startup, if launched with a user message (`omp "check this"`), skip the immediate due check. Later session switches still process due jobs.
4. **Missed window.** `catch_up_one` fires once when overdue, including after a
   session-scoped job's owner resumes. `skip` only fires within grace
   (`max(2×tick, 25% period)`), otherwise it advances without firing.
5. **In-session ticker**: every 30s, if the agent is idle, process newly due jobs (capped).
6. **`run_now`**: attempts force delivery; tool reports **actual** status (`ok` / `locked` / `error`), never invents success.
7. **Locks + ledger**: O_EXCL file lock + idempotency key; forensic trail in `~/.omp/schedule/runs.jsonl`.

Fired jobs use an isolated prompt contract:

```text
[scheduled-task]
runId: …
jobId: …
…

## Task
…

## Contract
- isolated run; do not invent findings; say "No findings" if empty
- PRIVILEGE: read_only | suggest | mutate
```

## File layout

```
~/.omp/schedule/
  schedules.json
  sessions/<session-id-hash>.json
  runs.jsonl
  locks/

<project>/.omp/schedule.json
```

## Reliability

Deep dive: **[docs/RELIABILITY.md](docs/RELIABILITY.md)**

Summary of MVP mitigations:

- External clock (`nextRunAt`), not LLM timing
- Missed-window policy + fire caps
- Single-flight locks + idempotency keys
- Append-only run ledger (`history`)
- Privilege tiers in the fire prompt
- Create rate limit + max 50 jobs in each global, project, or session scope file

## MVP scope

- tool + skill (a `schedule` skill ships in `skills/`, teaching kind/tier/scope/missed-window choices and self-contained prompt writing); no dedicated `/schedule` slash command yet
- action kinds: prompt / shell / notify / message (shell via `bash -lc`, optional `wakeOn`)
- lifecycle: `once` one-shots + `maxRuns` bounded polling
- no cron expressions yet
- no background OS daemon (in-session only; global and project stores are ready for one)
- `delivered` = action executed (prompt injected / shell finished / notify shown), not “agent finished correctly”

## Dev

```bash
npm install
npm test
npm run typecheck
```

## Release model

Git tags are immutable release pointers. Consumers who require a fully fixed
dependency should install a full commit SHA. GitHub Actions runs type checking
and all tests for every push and pull request; releases do not publish to npm.

See [NOTICE.md](NOTICE.md) for upstream attribution and the OMP-specific delta.

## License

MIT
