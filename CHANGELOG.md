# Changelog

## Unreleased

- Wait for `session_start` before arming session-boundary timers. ACP resume can
  emit a session switch before extension action APIs are initialized; deferring
  that work prevents a startup crash without weakening shell-capability checks.
- Require the caller's active `bash` capability for schedule mutations and job
  execution, including automatic due checks and queued runs. Read-only scouts
  retain `list`/`history` but cannot use the scheduler as a substitute shell.
- Default scope for `create` is now `session` (was `project` when `.omp/`
  exists in the cwd, otherwise `global`). Pass `scope=project` or
  `scope=global` explicitly for jobs that must outlive this conversation.
- Fire prompts now include a `scope:` line in the `[scheduled-task]` header so
  the agent can see which scope a fired job belongs to.
- Non-agent displays now carry the scope: notify toasts, message notes, and
  shell start/exit notices render `[omp-schedule:session] …`. Message notes
  previously had no attribution at all.
- Add explicit `session` scope alongside `global` and `project`. Session jobs
  use per-session files and only the matching OMP session ID can list, manage,
  inspect history, force, or automatically fire them. Create responses now
  report the selected scope.
- Keep session jobs dormant while their owner is closed. Resuming the same
  session applies the existing `missedWindow` policy. Session files remain after
  crashes or deleted sessions because the scheduler has no heartbeat or
  automatic garbage collection.

## 0.3.2-omp.2

- Regenerate the Bun lockfile against the public npm registry so contributors
  and GitHub Actions do not depend on ByteDance's internal package mirror.

## 0.3.2-omp.1

- Adapt upstream `pi-schedule` 0.3.2 to Oh My Pi 17.2.9 lifecycle events.
- Add immediate overdue processing on OMP startup and deferred processing on
  new, resume, fork, and handoff session switches.
- Move persistent data from Pi paths to OMP-specific global and project paths.
- Replace Pi `agent_settled` privilege cleanup with continuation-aware OMP
  `agent_end` handling.
- Support OpenAI Responses strict tool schemas without treating generated
  placeholder fields as user input.
- Use OMP's injected TypeBox implementation so Git installs have no runtime
  package dependencies.
- Validate the adaptation with 163 automated tests and real OMP end-to-end
  create/list/run/history/enable/disable/cancel, shell, and restart recovery
  checks.
