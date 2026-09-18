# Changelog

## Unreleased

- Require the caller's active `bash` capability for schedule mutations and job
  execution, including automatic due checks and queued runs. Read-only scouts
  retain `list`/`history` but cannot use the scheduler as a substitute shell.

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
