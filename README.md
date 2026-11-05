# omp-schedule

**Your omp session gets a prompt later, as if you had typed it.**

`/schedule 30m check whether the deploy finished` sends that prompt 30 minutes from now, into the session you typed it in. The agent has the whole conversation and every tool, and no other session ever picks the job up. The agent can schedule the same way with its `schedule` tool.

## Install

```sh
omp plugin marketplace add materemias/omp-schedule
omp plugin install omp-schedule@omp-schedule
```

Restart omp. To update, run `omp plugin upgrade omp-schedule@omp-schedule`.

## Commands

```
/schedule 30m <prompt>         once, 30 minutes from now
/schedule every 2h <prompt>    every 2 hours, first run in 2 hours
/schedule                      list this session's jobs
/schedule cancel <id|all>
```

A duration is `30s`, `10m`, `2h`, `1d`, or a combination such as `1h30m`. An interval must be at least `1m`. The footer shows the next fire time, and `+2` after it means two more jobs are waiting.

## From the agent

The `schedule` tool has three actions:

- `create` takes `prompt` and either `in` (once) or `every` (repeating).
- `list` shows this session's jobs.
- `cancel` takes `id`, a job id or `all`.

Ask for it in plain words, such as "check the CI run again in 20 minutes". The prompt arrives as a user message, so it can refer to the conversation. A subagent can't schedule, because its session ends with its task and the job would never fire.

## When jobs fire

An idle agent starts a turn on the prompt right away. A busy agent gets it as a follow-up after the current turn. If several jobs are due together, the first one starts the turn and the rest queue behind it.

Jobs are stored in `~/.omp/agent/schedule/<sessionId>.json`, so they survive `/restart` and resume. Only the session with that ID reads the file.

## Limits

- Nothing runs while the session is closed, because there is no daemon. On resume each overdue job fires once, and a recurring job counts its next run from that moment.
- Forks, branches and handoffs get a new session ID and take no jobs with them. The jobs stay with the original session.
- There is no clock-time schedule. For "at 20:00", give the delay. The agent works it out from the current time.

MIT.
