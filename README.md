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
/schedule every 10m for 2h <prompt>    every 10 minutes for 2 hours, then stop
/schedule                      list this session's jobs
/schedule cancel <id|all>
```

A duration is `30s`, `10m`, `2h`, `1d`, or a combination such as `1h30m`. An interval must be at least `1m`. The footer shows the next fire time, and `+2` after it means two more jobs are waiting.

While you type, the command suggests what comes next: units for a bare number (`2` offers `2m`, `2h`, `2d`, `2s`) with the time each would fire, valid intervals after `every`, `for` windows after the interval, and this session's job ids and `cancel all` after `cancel`. Press `Tab` to take one.

A `for` window ends a repeating job. `every 1h for 3h` runs three times, and the job disappears after the last run. The window must be at least one interval long. A prompt can still start with the word "for": only "for" followed by a digit opens a window.

## From the agent

The `schedule` tool has three actions:

- `create` takes `prompt` and either `in` (once) or `every` (repeating). `every` can take `for`, a window after which the job stops.
- `list` shows this session's jobs.
- `cancel` takes `id`, a job id or `all`.

Ask for it in plain words, such as "check the CI run again in 20 minutes". The prompt arrives as a user message, so it can refer to the conversation. Only an interactive session can schedule: a subagent or print session ends with its task, so its job would never fire.

## When jobs fire

An idle agent starts a turn on the prompt right away. A busy agent gets it as a follow-up after the current turn. If several jobs are due together, the first one starts the turn and the rest queue behind it. After a resume or a session switch, overdue jobs wait 2 seconds so omp can restore the transcript first.

Jobs are stored in `~/.omp/agent/schedule/<sessionId>.json`, so they survive `/restart` and resume. Only the session with that ID reads the file.

## Limits

- Nothing runs while the session is closed, because there is no daemon. On resume each overdue job fires once, and a recurring job counts its next run from that moment. A job whose `for` window ended in the meantime is removed without firing. Resuming in print mode (`omp -p`) leaves the jobs waiting for an interactive session.
- Forks, branches and handoffs get a new session ID and take no jobs with them. The jobs stay with the original session.
- There is no clock-time schedule. For "at 20:00", give the delay. The agent works it out from the current time.
- A slash command in a prompt stays plain text. omp doesn't run it.
- If two omp processes have the same session open, each one fires its jobs, so a prompt can arrive twice.
- A delay or interval can be at most `365d`.

MIT.
