# Changelog

## Unreleased

## 0.2.0 (2026-11-13)

### Features

- `/schedule every 10m for 2h <prompt>` ends a repeating job after a time window. The agent's `schedule` tool takes the same limit as `for`.
- `/schedule` suggests `for` windows after an interval, and offers `cancel all` whenever the session has jobs.
- A row above the composer shows the next job, its time and its repeat from the moment you schedule it. It replaces the clock in the footer.
- `/schedule` opens a dialog with one row per job. Picking a row cancels that job after a confirmation.

### Fixes

- The agent no longer reaches for `schedule` to wait for a PR comment, CI or a reply: the tool says it only runs on a clock and points to an event-watching tool when the session has one.

## 0.1.0 (2026-11-05)

### Features

- `/schedule 30m <prompt>` sends a prompt into this session after a delay, and `/schedule every 2h <prompt>` repeats it. Each job fires only in the session that created it, as a plain user message.
- `/schedule` lists this session's jobs and `/schedule cancel <id|all>` removes them. The footer shows the next fire time.
- `/schedule` suggests durations with their fire time, intervals and job ids as you type.
- The agent can schedule into its own session with the `schedule` tool.
- Jobs survive `/restart` and resume. On resume each overdue job fires once, after a 2-second wait so the prompt lands in the restored transcript. A print-mode resume (`omp -p`) leaves them for an interactive session.
- A full disk, an unwritable job directory or a damaged job file shows an error in omp instead of taking the session down.
