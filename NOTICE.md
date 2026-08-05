# Upstream attribution and adaptation

`omp-schedule` is derived from
[`pungggi/pi-schedule`](https://github.com/pungggi/pi-schedule), version 0.3.2,
commit `1af98f0113636a4b2d7351c10af2d4e39091fcc1`.

The upstream project is Copyright (c) 2025 Alessandro Pungitore and is
distributed under the MIT License preserved in [LICENSE](LICENSE).

This adaptation keeps the scheduling model and reliability controls while
making the package native to Oh My Pi 17.2.9 and later:

- uses OMP extension APIs and its injected TypeBox implementation;
- handles OMP `session_start`, `session_switch`, `session_shutdown`, and final
  `agent_end` lifecycle events;
- defers switch-triggered delivery until a resumed transcript is committed;
- stores global state under `~/.omp/schedule` and project state under
  `<project>/.omp/schedule.json`;
- normalizes OpenAI Responses strict-schema placeholder values before
  action-specific validation;
- ships OMP-specific lifecycle, privilege, storage, and integration tests.

The OMP-specific adaptation is maintained by Zihao Han
([@hanhan3344](https://github.com/hanhan3344)).
