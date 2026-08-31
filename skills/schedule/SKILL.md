---
name: schedule
description: 'Schedule recurring agent tasks and actions. Covers polls for CI, builds, deploys, tests, and PR status, plus periodic checks, security reviews, version checks, reminders, and scans. Owns the `schedule` tool (create / list / cancel / run_now / history) and its design choices: kind (prompt/shell/notify/message), every vs dailyAt, tier (read_only/suggest/mutate), wakeOn for shell, missed-window policy, global/project/session scope, and self-contained prompts for isolated runs. Use when the user wants to poll, watch, or check something repeatedly, says "check every N minutes", "keep an eye on", "monitor", "ping me when", "alert me if", "tell me if X", "wait until", "every day", "hourly", "daily at", "schedule", "recurring", "periodic", "remind me", or "cron".'
---

# Schedule — recurring agent tasks

This skill drives the **`schedule`** tool provided by the `omp-schedule` package.
The tool is purely mechanical (it stores and fires jobs). The *value* comes
from choosing the parameters well and writing a prompt that still makes sense
when it fires with zero chat context. That's what this file covers.

## How firing works (read this first)

What fires depends on **`kind`**:
- **prompt** — isolated agent turn (below)
- **shell** — runs `command` first; agent turn only if `wakeOn` says so
- **notify** / **message** — human-visible only; **no** agent turn

For **prompt** (and shell wakes), the job is an **isolated turn** — a brand-new
user message with **no prior conversation**. Pi injects a contract header, then
your instruction:

```
[scheduled-task]
runId: …  jobId: …  name: …  action: prompt  schedule: …  tier: read_only
## Task
<your prompt, verbatim>
## Contract
- Isolated run. Focus only on this task.
- If tools fail or data is missing, report it; do NOT invent findings.
- If nothing is actionable, say so (e.g. "No findings").
- Prefer evidence over unsupported claims.
- Don't touch other schedules.
PRIVILEGE: read_only   →  edit/write/bash are BLOCKED for this turn
```

Two consequences shape every decision below:

1. **Your prompt must be fully self-contained.** No "as we discussed". No
   references to earlier turns. State the goal, the scope, and the expected
   output in the prompt itself.
2. **Privilege is enforced structurally**, not just by wording. A fired turn
   literally cannot call the blocked tools (see the tier table). So pick the
   tier by what the task *actually needs to run*, not by vibe. Quiet shell /
   notify / message fires never enter the privilege stack.

Eligible jobs fire on **OMP session start or switch** when due. Initial startup
skips the check if OMP was launched with a prompt, such as `omp "fix the bug"`.
The 30-second ticker also fires due jobs while an OMP session stays open and the
agent is idle. Session-scoped jobs are eligible only for their exact OMP session
ID. There is **no background OS daemon**.

## The tool at a glance

```
schedule
  action: create | list | cancel | enable | disable | run_now | history
  name          (create) short label
  kind          (create) prompt | shell | notify | message   (default prompt)
  prompt        (create) task/reminder text; optional shell follow-up
  command       (create, kind=shell) shell command via bash -lc
  wakeOn        (create, kind=shell) always | failure | success | never
  successPrompt / failurePrompt   (shell) outcome-specific agent text
  timeoutMs     (shell) default 60000, max 600000
  once          (create) one-shot delay ("10m"/"30s"), then terminate (xor every/dailyAt)
  maxRuns       (create) cap deliveries (ok+error) before auto-disable
  every         (create) "30m" | "2h" | "1d"   (xor with dailyAt/once)
  dailyAt       (create) "09:00" local time   (xor with every/once)
  scope         global | project | session    (default: project if .omp/ exists in cwd, otherwise global)
  tier          read_only | suggest | mutate  (default read_only; shell forces mutate)
  missedWindow  catch_up_one | skip           (default catch_up_one)
  id            (cancel/enable/disable/run_now/history)
  limit         (history, default 10, max 50)
```

**Interval rules:** min `1m`, max `90d`; `once` allows seconds (`30s`) up to `90d`.
**Always `list` before `create`** to avoid duplicate jobs (no auto-dedup).
**Terminated jobs** (once fired / maxRuns reached) are disabled and skipped by due scans; re-enable clears the flag, or cancel + recreate.
**Create reports scope.** Every create response states the selected scope,
including when the tool chose the default.

## Decisions

### `kind` — what should fire?

| Want | kind | Notes |
|---|---|---|
| Agent does the work (review, summarize, draft) | **prompt** (default) | Isolated contract + tier enforcement |
| Run a command; wake agent only sometimes | **shell** | No model tokens on quiet success; use `wakeOn=failure` for CI |
| Nudge the human only | **notify** | UI/console; no agent turn |
| Drop a note into the session | **message** | Display-only custom message; no agent turn |

**Shell rules:**
- Requires `command`. Always stored as `tier=mutate`.
- `wakeOn` default: `always` if any follow-up text (`prompt` / `successPrompt` / `failurePrompt`) is set, else `never`.
- Prefer **`wakeOn=failure`** for polls (pipeline, deploy, tests) so green stays silent.
- Follow-up priority: `successPrompt` → `failurePrompt` → `prompt` → generic review text.

Do **not** use `kind=shell` for open-ended investigation — use `kind=prompt` with `tier=mutate` so the agent chooses commands.

### Lifecycle — `once` vs recurring vs `maxRuns`

| Want | Use |
|---|---|
| Fire one time, then stop | **`once="10m"`** (relative; seconds allowed) |
| Recurring heartbeat / review | **`every`/`dailyAt`** (open-ended) |
| Bounded poll — stop after N checks | **`every` + `maxRuns=N`** |

A job that reaches its end state is **terminated** (`once` → one fire; `maxRuns` → after N deliveries, counting ok+error). Terminated = disabled + excluded from due scans. `run_now` refuses a terminated job (recreate instead); `enable` clears the flag to resume a `maxRuns` job.

### `every` vs `dailyAt`

| Want | Use | Examples |
|---|---|---|
| Relative cadence / heartbeat | `every` | polls, health checks, heartbeats: `30m`, `2h`, `1d` |
| A specific wall-clock time | `dailyAt` | morning reviews, end-of-day reports: `09:00`, `17:30` |

Rule of thumb: **polls → `every`; reports/reviews → `dailyAt`.** `dailyAt` is
local timezone and DST-safe.

### `scope`

Choose among `global`, `project`, and `session`:

- **session** is explicit only. Use it when the task must never enter another
  conversation. Jobs live in
  `~/.omp/schedule/sessions/<session-id-hash>.json`. Only the exact OMP session
  ID can list, manage, inspect history, `run_now`, or automatically fire them.
  Other sessions never fall back to this file.
- **project** applies by default when `.omp/` exists in the current directory.
  Use it for repo-specific work such as security reviews, dependency checks,
  and tests. Launch OMP from the project root.
- **global** applies by default outside a project. Jobs live in
  `~/.omp/schedule/schedules.json`. Use it for personal reminders and checks
  that can run in any conversation.

Closing a session leaves its jobs dormant. Resuming that session applies the
job's `missedWindow` policy. `catch_up_one` delivers one overdue slot, while
`skip` discards stale work. New, forked, branched, and handed-off sessions have
different IDs. Session files remain after crashes or deleted sessions. The
scheduler has no session heartbeat or automatic garbage collection.

### `tier` — pick by what the task must *run*

| Tier | Tools blocked on the fired turn | Use when |
|---|---|---|
| **read_only** (default) | `edit`, `write`, **`bash`** | Read/search/analyze only — codebase retrieval, reading files, summarizing. **Cannot run shell commands.** |
| **suggest** | `bash` | Drafting patches or proposals in-message (edits/writes allowed) but not executing shell, not committing. |
| **mutate** | none | The task must change files **or run shell** (`git`, `npm`, `gh`, scripts). This is the **only** tier that allows `bash`; use sparingly — it runs unattended. |

> ⚠️ The biggest gotcha: a task that needs the **shell** (e.g. `npm outdated`,
> `git log`, running a script) **must be `tier="mutate"`**. Both `read_only`
> **and** `suggest` block `bash` — `suggest` only unlocks `edit`/`write` for
> drafting, it does **not** unlock the shell. Default to the **lowest tier the
> task can actually succeed at.**

### `missedWindow` — what happens when a fire is overdue

- **catch_up_one** (default): fire once for the missed slot, then reschedule.
  Right when you don't want to miss a beat (reviews, reports).
- **skip**: only fire if still within grace (interval: `max(2×tick, 25% of period)`,
  capped at 15m; daily: 1h); otherwise roll forward **without firing**. Right
  when stale results are useless (hourly status polls, heartbeats).

## Writing the prompt (the part that matters)

Each fire is isolated, so the prompt is the whole brief. Checklist:

- **Goal in one line.** What is this run trying to produce?
- **Scope & inputs.** Which files/paths/packages/commands? Don't assume cwd context.
- **Expected output.** "Summarize findings", "list outdated packages with current→latest", "report No findings if clean".
- **Constraints.** "Focus only on `src/auth/`", "ignore devDependencies".
- **Escape hatch.** Tell it to say "No findings" when there's nothing — otherwise the model may fabricate to seem useful.

Good prompt (self-contained):

```
Review the code in src/auth/ for security issues (injection, auth bypass,
secrets). Summarize concrete findings with file:line. If none, reply exactly
"No findings". Do not modify anything.
```

Bad prompt (depends on context that won't exist):

```
check the thing we talked about and tell me if it's still broken
```

## Recipes

Use session scope for a reminder that must stay in this conversation:

```text
schedule action=create name="decision-follow-up" kind="notify"
  prompt="Revisit the pending deployment decision in this conversation."
  once="30m" scope="session"
```

**`kind=prompt` + `read_only` — pure read/search, no shell (no `git`/`npm`/`gh`):**

```text
# Daily STATIC security review of auth code (no git → read_only is valid)
schedule action=create name="security-review"
  prompt="Review the code under src/auth/ for security issues (injection, auth bypass, exposed secrets). Cite file:line. If none, reply 'No findings'. Do not modify anything."
  dailyAt="09:00" scope="project" tier="read_only"

# Daily scan for hardcoded secrets across src/ (read/search only)
schedule action=create name="secret-scan"
  prompt="Search src/ for hardcoded secrets, API keys, passwords, and credentials. List each hit as path:line with the token redacted. If none, reply 'No findings'."
  every="1d" tier="read_only" missedWindow="catch_up_one"
```

**`kind=shell` — direct command, wake only when useful:**

```text
# Poll CI every 5m; wake agent only on failure (quiet when green)
schedule action=create name="ci-poll" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion' | grep -vq failure"
  wakeOn="failure"
  failurePrompt="Latest CI run failed. Inspect jobs/logs and propose or apply fixes."
  every="5m" missedWindow="skip"

# Run tests later and always review output
schedule action=create name="test-pass" kind="shell"
  command="npm test"
  wakeOn="always"
  prompt="Review this test output. If failed, fix; if passed, summarize."
  every="1d"
```

**`kind=notify` — human reminder, zero agent tokens:**

```text
schedule action=create name="stretch" kind="notify"
  prompt="Stand up and stretch for 2 minutes." every="1h"
```

**`kind=prompt` + `mutate` — agent must drive the shell:**

```text
# Daily dependency check — agent runs `npm outdated`, so tier=mutate
schedule action=create name="pkg-outdated"
  prompt="Run `npm outdated` for prod deps. Report meaningful updates as current→latest with a one-line rationale. If nothing meaningful, reply 'No findings'."
  every="1d" tier="mutate" missedWindow="skip"

# Morning standup prep — reads git log, so tier=mutate
schedule action=create name="standup-prep"
  prompt="Read recent git log (last ~2 days) and draft 3 standup bullets: done, next, blockers. One line each."
  dailyAt="09:15" scope="global" tier="mutate"
```

## Guardrails & verification

- **Limits:** each global, project, or session scope file holds at most 50 jobs.
  The process accepts at most 10 creates per minute, 5 fires at session start,
  and 3 fires per tick. A tight loop such as `every="1m"` will spam each session
  that can see the job.
- **Verify a job works before trusting it:**
  - `schedule action=run_now id=<id>` — fires once immediately and reports the
    **actual** status (`ok` / `locked` / `error` / `skipped`), never fake success.
  - `schedule action=history id=<id>` — append-only forensic trail of past runs.
  - `schedule action=list` — current jobs, next/last run, run count, last status.
- **Privilege failures are silent-ish.** If a `read_only` job tries to run
  `bash`, the call is blocked and the run likely errors. Check `history` if a
  job's `lastStatus` is `error`.
- **Stop noise:** `action=disable` pauses a job (keeps it); `action=cancel`
  deletes it. Don't leave noisy jobs running.

## Reference

- Reliability deep-dive (missed-window math, locks, ledger, fire caps):
  [../../docs/RELIABILITY.md](../../docs/RELIABILITY.md)
- Package README: [../../README.md](../../README.md)
