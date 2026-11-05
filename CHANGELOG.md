# Changelog

## Unreleased

### Fixes

- Agents now see when to reach for the `schedule` tool. omp lists a tool by its first description line, cut at 200 bytes, and that line used to say nothing about rechecks, reminders or polls.

## 0.1.0 (2026-11-05)

### Features

- `/schedule 30m <prompt>` sends a prompt into this session after a delay, and `/schedule every 2h <prompt>` repeats it. Each job fires only in the session that created it, exactly as if you had typed the prompt.
- `/schedule` lists this session's jobs and `/schedule cancel <id|all>` removes them. The footer shows the next fire time.
- The agent can schedule into its own session with the `schedule` tool.
- Jobs survive `/restart` and resume. On resume each overdue job fires once.
