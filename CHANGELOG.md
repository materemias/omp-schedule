# Changelog

## Unreleased

### Fixes

- Agents now see when to reach for the `schedule` tool. omp lists a tool by its first description line, cut at 200 bytes, and that line used to say nothing about rechecks, reminders or polls.
- A full disk or an unwritable job directory no longer takes the whole omp session down when a job fires. The error shows in omp, and other jobs still fire.
- A hand-edited or damaged job file no longer crashes omp or spins the timer. Only its valid jobs load.
- A print-mode resume (`omp -p`) no longer consumes overdue jobs. They wait for an interactive session.
- Overdue jobs wait 2 seconds after a resume or session switch, so their prompts land in the restored transcript.
- A job that can't be saved is reported as an error and doesn't stay in memory.
- Durations are limited to `365d`. Huge values used to create jobs that fired at once after a resume.
- A cancelled job's id isn't reused while the session runs.
- `/schedule every 2h` without a prompt and `/schedule cancel 1 2` show the usage text instead of a bad duration error.

## 0.1.0 (2026-11-05)

### Features

- `/schedule 30m <prompt>` sends a prompt into this session after a delay, and `/schedule every 2h <prompt>` repeats it. Each job fires only in the session that created it, exactly as if you had typed the prompt.
- `/schedule` lists this session's jobs and `/schedule cancel <id|all>` removes them. The footer shows the next fire time.
- The agent can schedule into its own session with the `schedule` tool.
- Jobs survive `/restart` and resume. On resume each overdue job fires once.
