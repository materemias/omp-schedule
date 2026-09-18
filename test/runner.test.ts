/**
 * ScheduleRunner integration — the orchestration core.
 *
 * Drives the real store + ledger + locks + privilege with a fake pi/ctx and a
 * controllable clock. Covers the reliability guarantees that were previously
 * unverified: at-most-once delivery, fire caps, idle gate, run_now bypass,
 * missed-window skip, error advance, lock contention, and startup-skip.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { RunLedger } from "../src/ledger.js";
import { JobLockManager } from "../src/lock.js";
import { PrivilegeGuard } from "../src/privilege.js";
import { ScheduleRunner } from "../src/runner.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";
import { parseSchedule } from "../src/schedule.js";
import type { PrivilegeTier, ScheduledJob } from "../src/types.js";

const T0 = "2025-01-01T00:00:00.000Z";
const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  vi.useRealTimers();
});

interface HarnessOpts {
  idle?: boolean;
  sendThrows?: boolean;
  hasInitialPrompt?: boolean;
  hasUI?: boolean;
  execResult?: { stdout?: string; stderr?: string; code?: number; killed?: boolean };
  execThrows?: boolean;
  execDeferred?: Promise<{
    stdout?: string;
    stderr?: string;
    code?: number;
    killed?: boolean;
  }>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-sched-runner-"));
  temps.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const paths = defaultPaths(home);

  const store = new ScheduleStore(paths);
  const ledger = new RunLedger(paths.runsFile);
  const locks = new JobLockManager(paths.lockDir);
  const privilege = new PrivilegeGuard();

  let clock = new Date(T0);
  let sessionId = "session-a";
  let idle = opts.idle ?? true;
  let activeTools = ["read", "bash", "schedule"];
  const sent: { content: string; deliverAs?: string }[] = [];
  const customMessages: Array<{ content: string; triggerTurn?: boolean }> = [];
  const notifies: string[] = [];
  const execCalls: Array<{ command: string; args: string[]; cwd?: string; timeout?: number }> =
    [];
  const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> =
    {};

  const pi = {
    getActiveTools: () => activeTools,
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void {
      (handlers[event] ??= []).push(handler);
    },
    sendUserMessage(
      content: string,
      o?: { deliverAs?: "steer" | "followUp" },
    ): void {
      if (opts.sendThrows) throw new Error("boom");
      sent.push({ content, deliverAs: o?.deliverAs });
    },
    sendMessage(
      message: { content: string },
      o?: { triggerTurn?: boolean },
    ): void {
      customMessages.push({
        content: message.content,
        triggerTurn: o?.triggerTurn,
      });
    },
    async exec(
      command: string,
      args: string[],
      o?: { cwd?: string; timeout?: number },
    ) {
      execCalls.push({
        command,
        args,
        cwd: o?.cwd,
        timeout: o?.timeout,
      });
      if (opts.execThrows) throw new Error("exec boom");
      const r = opts.execDeferred
        ? await opts.execDeferred
        : (opts.execResult ?? {});
      return {
        stdout: r.stdout ?? "ok\n",
        stderr: r.stderr ?? "",
        code: r.code ?? 0,
        killed: r.killed ?? false,
      };
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: project,
    sessionManager: {
      getCwd: () => project,
      getSessionId: () => sessionId,
    },
    hasUI: opts.hasUI ?? true,
    isIdle: () => idle,
    ui: { notify: (m: string) => notifies.push(m) },
  } as unknown as ExtensionContext;

  const runner = new ScheduleRunner({
    store,
    pi,
    ledger,
    locks,
    privilege,
    hasInitialPrompt: () => opts.hasInitialPrompt === true,
    now: () => clock,
    tickMs: 1_000,
  });

  const createGlobal = (
    name = "job",
    tier: PrivilegeTier = "read_only",
    missedWindow: ScheduledJob["missedWindow"] = "catch_up_one",
  ): ScheduledJob =>
    store.create({
      name,
      prompt: "do the thing",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      tier,
      missedWindow,
    });

  return {
    root,
    project,
    store,
    ledger,
    privilege,
    runner,
    ctx,
    pi,
    sent,
    customMessages,
    notifies,
    execCalls,
    lockDir: paths.lockDir,
    createGlobal,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
    setClock: (d: Date) => {
      clock = d;
    },
    setIdle: (b: boolean) => {
      idle = b;
    },
    setSessionId: (id: string) => {
      sessionId = id;
    },
    forceDue: (id: string, when = T0, owner = sessionId) => {
      const j = store.get(id, project, owner);
      if (j) store.upsert({ ...j, nextRunAt: when });
    },
    emit: async (event: string, e?: unknown) => {
      for (const h of handlers[event] ?? []) await h(e, ctx);
    },
  };
}

type H = ReturnType<typeof makeHarness>;

describe("ScheduleRunner — delivery", () => {
  it("fires a due job once: message + privilege.enter + advance + ledger", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("[scheduled-task]");
    expect(h.sent[0]?.content).toContain("PRIVILEGE: read_only");
    // privilege entered for the turn; not yet settled
    expect(h.privilege.depth()).toBe(1);

    const after = h.store.get(job.id, h.project)!;
    expect(after.runCount).toBe(1);
    expect(after.lastStatus).toBe("ok");
    expect(after.lastIdempotencyKey).toBe(`${job.id}:${T0}`);
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(
      new Date(T0).getTime(),
    );
    expect(
      h.ledger.history({}).some((r) => r.status === "delivered"),
    ).toBe(true);
  });

  it("does not double-fire the same slot (at-most-once via lastIdempotencyKey)", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);

    // Simulate a race: nextRunAt not yet advanced for a second wave.
    h.forceDue(job.id); // same slot again
    await h.runner.fireDue(h.ctx, { source: "tick" });

    expect(h.sent).toHaveLength(1); // no second delivery
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("skipped");
    expect(after.runCount).toBe(1); // skip does not increment
  });

  it("run_now bypasses idempotency (unique force key, always attempts)", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [job.id] });
    await h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [job.id] });

    expect(h.sent).toHaveLength(2);
  });

  it("uses session identity, not cwd, to select session-scoped jobs", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "private",
      prompt: "session A only",
      schedule: parseSchedule("every 1h"),
      scope: "session",
      sessionId: "session-a",
    });
    h.forceDue(job.id, T0, "session-a");

    h.setSessionId("session-b");
    await expect(
      h.runner.fireDue(h.ctx, { source: "session_start" }),
    ).resolves.toEqual([]);
    expect(h.sent).toHaveLength(0);
    expect(h.store.get(job.id, h.project, "session-b")).toBeUndefined();

    h.setSessionId("session-a");
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("session A only");
  });
});

describe("ScheduleRunner — caps & gating", () => {
  it("does not fire or mutate due jobs through restricted lifecycle or manual entrypoints", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const shell = h.store.create({
      name: "restricted-shell",
      action: "shell",
      command: "printf forbidden",
      wakeOn: "always",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    const prompt = h.createGlobal("restricted-prompt");
    h.forceDue(shell.id);
    h.forceDue(prompt.id);
    const before = h.store.listForCwd(h.project, "session-a");
    h.setActiveTools(["read", "schedule"]);
    h.runner.attach();

    try {
      await h.emit("session_start", { type: "session_start" });
      await h.emit("session_switch", { type: "session_switch", reason: "new" });
      await vi.advanceTimersByTimeAsync(0);
      await h.emit("session_branch", { type: "session_branch" });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(
        h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [shell.id] }),
      ).rejects.toThrow("active bash tool");
      expect(h.store.listForCwd(h.project, "session-a")).toEqual(before);
      expect(h.ledger.history({})).toEqual([]);
      expect(h.execCalls).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.customMessages).toEqual([]);
      expect(h.notifies).toEqual([]);
    } finally {
      await h.emit("session_shutdown");
    }

    h.setActiveTools(["read", "bash", "schedule"]);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.execCalls).toHaveLength(1);
    expect(h.store.get(shell.id, h.project)?.runCount).toBe(1);
    expect(h.store.get(prompt.id, h.project)?.runCount).toBe(1);
  });

  it("rechecks bash between jobs and queued waves, and suppresses restricted follow-ups", async () => {
    let finishExec: (() => void) | undefined;
    const execDeferred = new Promise<{ code: number }>((resolve) => {
      finishExec = () => resolve({ code: 0 });
    });
    const h = makeHarness({ execDeferred });
    const shell = h.store.create({
      name: "in-flight",
      action: "shell",
      command: "slow-check",
      wakeOn: "always",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    const queued = h.createGlobal("queued");
    const before = h.store.get(queued.id, h.project);
    const first = h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [shell.id, queued.id] });
    await Promise.resolve();
    expect(h.execCalls).toHaveLength(1);
    const second = h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [queued.id] });
    const blocked = expect(second).rejects.toThrow("active bash tool");
    const interrupted = expect(first).rejects.toThrow("active bash tool");
    h.setActiveTools(["read", "schedule"]);
    if (!finishExec) throw new Error("missing shell completion");
    finishExec();
    await interrupted;
    await blocked;
    expect(h.execCalls).toHaveLength(1);
    expect(h.store.get(queued.id, h.project)).toEqual(before);
    expect(h.ledger.history({ jobId: queued.id })).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.customMessages).toEqual([]);

    h.setActiveTools(["read", "bash", "schedule"]);
    await h.runner.fireDue(h.ctx, { source: "run_now", jobIds: [queued.id] });
    expect(h.store.get(queued.id, h.project)?.runCount).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it("caps session_start fires at maxFiresPerSessionStart; over-cap jobs stay due", async () => {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const j = h.createGlobal(`j${i}`);
      h.forceDue(j.id);
      ids.push(j.id);
    }

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(5); // LIMITS.maxFiresPerSessionStart

    let fired = 0;
    let untouched = 0;
    for (const id of ids) {
      const j = h.store.get(id, h.project)!;
      if (j.runCount === 1 && j.lastStatus === "ok") fired += 1;
      else if (j.runCount === 0 && j.lastStatus === null) untouched += 1;
    }
    expect(fired).toBe(5);
    expect(untouched).toBe(2); // not advanced, no ledger spam
  });

  it("tick wave is a no-op while the agent is busy (not idle)", async () => {
    const h = makeHarness({ idle: false });
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.sent).toHaveLength(0);

    h.setIdle(true);
    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("ScheduleRunner — policies & failure", () => {
  it("skip policy advances without firing or counting when overdue beyond grace", async () => {
    const h = makeHarness();
    h.setClock(new Date("2025-01-01T02:00:00.000Z"));
    const job = h.store.create({
      name: "skip",
      prompt: "p",
      schedule: parseSchedule("every 1h"),
      scope: "global",
      tier: "read_only",
      missedWindow: "skip",
    });
    h.store.upsert({ ...job, nextRunAt: T0 }); // 2h overdue (> 15m grace)

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("skipped");
    expect(after.runCount).toBe(0);
    expect(after.nextRunAt).not.toBe(T0); // advanced forward
  });

  it("delivery error still advances nextRunAt (no hot-loop) and counts", async () => {
    const h = makeHarness({ sendThrows: true });
    const job = h.createGlobal();
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0); // threw before recording
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("boom");
    expect(after.runCount).toBe(1); // error counts
    expect(after.nextRunAt).not.toBe(T0); // advanced
    expect(
      h.notifies.some((m) => m.includes("[omp-schedule:global] failed to fire")),
    ).toBe(true);
    expect(
      h.ledger.history({}).some((r) => r.status === "error"),
    ).toBe(true);
  });

  it("lock contention: no fire, no advance; release → fires", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);

    const contender = new JobLockManager(h.lockDir);
    const handle = contender.tryAcquire(job.id);
    expect(handle).not.toBeNull();

    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(0);
    const mid = h.store.get(job.id, h.project)!;
    expect(mid.lastStatus).toBeNull();
    expect(mid.runCount).toBe(0);

    handle!.release();
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("ScheduleRunner — attach (session lifecycle)", () => {
  it("OMP startup + CLI initial prompt skips firing; session_switch still fires", async () => {
    // startup WITH initial prompt → skip
    const a = makeHarness({ hasInitialPrompt: true });
    const ja = a.createGlobal();
    a.forceDue(ja.id);
    a.runner.attach();
    await a.emit("session_start", { type: "session_start" });
    expect(a.sent).toHaveLength(0);
    await a.emit("session_shutdown");

    // /new WITH inherited argv → still fires via OMP's dedicated switch event.
    const b = makeHarness({ hasInitialPrompt: true });
    const jb = b.createGlobal();
    b.forceDue(jb.id);
    b.runner.attach();
    await b.emit("session_switch", {
      type: "session_switch",
      reason: "new",
      previousSessionFile: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.sent).toHaveLength(1);
    await b.emit("session_shutdown");

    // startup WITHOUT initial prompt → fires
    const c = makeHarness({ hasInitialPrompt: false });
    const jc = c.createGlobal();
    c.forceDue(jc.id);
    c.runner.attach();
    await c.emit("session_start", { type: "session_start" });
    expect(c.sent).toHaveLength(1);
    await c.emit("session_shutdown");
  });

  it("coalesces rapid OMP session switches and uses the latest cwd", async () => {
    const h = makeHarness({ hasInitialPrompt: true });
    const job = h.createGlobal();
    h.forceDue(job.id);
    h.runner.attach();

    await h.emit("session_switch", {
      type: "session_switch",
      reason: "resume",
      previousSessionFile: "old.jsonl",
    });
    await h.emit("session_switch", {
      type: "session_switch",
      reason: "fork",
      previousSessionFile: "resumed.jsonl",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.sent).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("fires session jobs only when their owner resumes after new and branch boundaries", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ hasInitialPrompt: true });
    h.setClock(new Date("2025-01-01T02:00:00.000Z"));
    const catchUp = h.store.create({
      name: "owner-catch-up",
      prompt: "deliver to owner",
      schedule: parseSchedule("every 1h"),
      scope: "session",
      sessionId: "session-a",
      missedWindow: "catch_up_one",
    });
    const skip = h.store.create({
      name: "owner-skip",
      prompt: "do not deliver late",
      schedule: parseSchedule("every 1h"),
      scope: "session",
      sessionId: "session-a",
      missedWindow: "skip",
    });
    h.forceDue(catchUp.id, T0, "session-a");
    h.forceDue(skip.id, T0, "session-a");
    h.runner.attach();

    h.setSessionId("session-new");
    await h.emit("session_switch", {
      type: "session_switch",
      reason: "new",
      previousSessionFile: "session-a.jsonl",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(0);

    const global = h.createGlobal("branch-visible");
    h.forceDue(global.id);
    h.setSessionId("session-branch");
    await h.emit("session_branch", {
      type: "session_branch",
      previousSessionFile: "session-new.jsonl",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("branch-visible");
    expect(h.store.get(catchUp.id, h.project, "session-a")?.lastStatus).toBeNull();

    h.setSessionId("session-a");
    await h.emit("session_switch", {
      type: "session_switch",
      reason: "resume",
      previousSessionFile: "session-branch.jsonl",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.content).toContain("deliver to owner");
    expect(h.store.get(catchUp.id, h.project, "session-a")?.lastStatus).toBe("ok");
    expect(h.store.get(skip.id, h.project, "session-a")?.lastStatus).toBe(
      "skipped",
    );
    await h.emit("session_shutdown");
    vi.useRealTimers();
  });
});

describe("ScheduleRunner — construction & wave edges", () => {
  it("uses default collaborators when ledger/locks/privilege/now/tickMs are omitted", async () => {
    const h = makeHarness();
    const minimal = new ScheduleRunner({ store: h.store, pi: h.pi });
    // no due jobs → exercises the default now()/store path; returns []
    await expect(
      minimal.fireDue(h.ctx, { source: "session_start" }),
    ).resolves.toEqual([]);
  });

  it("drops an auto wave that arrives while another auto wave is active", async () => {
    const h = makeHarness();
    const job = h.createGlobal();
    h.forceDue(job.id);
    const first = h.runner.fireDue(h.ctx, { source: "session_start" });
    const dropped = await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(dropped).toEqual([]);
    await first;
    expect(h.sent).toHaveLength(1); // the first wave still delivered
  });

  it("auto-wave swallows a store error and notifies (never throws)", async () => {
    const h = makeHarness();
    mkdirSync(h.store.pathsInfo().globalDir, { recursive: true });
    writeFileSync(h.store.pathsInfo().globalFile, "{bad json", "utf8");
    await expect(
      h.runner.fireDue(h.ctx, { source: "session_start" }),
    ).resolves.toEqual([]);
    expect(h.notifies.some((m) => m.includes("store error"))).toBe(true);
  });

  it("delivers as followUp when the agent is busy (not idle)", async () => {
    const h = makeHarness({ idle: false });
    const job = h.createGlobal();
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.deliverAs).toBe("followUp");
  });

  it("logs to console.error on delivery failure when hasUI is false", async () => {
    const h = makeHarness({ sendThrows: true, hasUI: false });
    const job = h.createGlobal();
    h.forceDue(job.id);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(spy).toHaveBeenCalled();
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("error");
    spy.mockRestore();
  });
});

describe("ScheduleRunner — action kinds", () => {
  it("notify: UI only, no agent turn, no privilege", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "stretch",
      prompt: "stand up",
      action: "notify",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    expect(
      h.notifies.some(
        (m) =>
          m.includes("[omp-schedule:global]") &&
          m.includes("stretch") &&
          m.includes("stand up"),
      ),
    ).toBe(
      true,
    );
    expect(h.customMessages.some((m) => m.triggerTurn === false)).toBe(true);
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("ok");
  });

  it("message: session note without agent turn", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "note",
      prompt: "context for later",
      action: "message",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    expect(
      h.customMessages.some(
        (m) =>
          m.content.includes("[omp-schedule:global]") &&
          m.content.includes("context for later"),
      ),
    ).toBe(true);
  });

  it("shell: runs command, no wake when wakeOn=never", async () => {
    const h = makeHarness({
      execResult: { stdout: "green\n", code: 0 },
    });
    const job = h.store.create({
      name: "ci",
      prompt: "",
      action: "shell",
      command: "glab ci view",
      wakeOn: "never",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.execCalls).toHaveLength(1);
    expect(
      h.notifies.some((m) => m.includes("[omp-schedule:global] running shell")),
    ).toBe(true);
    expect(h.execCalls[0]?.command).toBe("bash");
    expect(h.execCalls[0]?.args).toEqual(["-lc", "glab ci view"]);
    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    expect(
      h.customMessages.some(
        (m) =>
          m.content.includes("[omp-schedule:global]") &&
          m.content.includes(`Shell "ci" exit 0`),
      ),
    ).toBe(true);
    expect(h.privilege.depth()).toBe(0);
    const after = h.store.get(job.id, h.project)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.lastShell?.code).toBe(0);
    expect(after.lastShell?.stdout).toContain("green");
  });

  it("shell: wakes agent on failure when wakeOn=failure", async () => {
    const h = makeHarness({
      execResult: { stdout: "",
        stderr: "boom", code: 2 },
    });
    const job = h.store.create({
      name: "ci",
      prompt: "Inspect the pipeline failure.",
      action: "shell",
      command: "false",
      wakeOn: "failure",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("action: shell");
    expect(h.sent[0]?.content).toContain("shellStatus: failure");
    expect(h.sent[0]?.content).toContain("Inspect the pipeline failure");
    expect(h.sent[0]?.content).toContain("exitCode: 2");
    expect(h.privilege.depth()).toBe(1);
  });

  it("shell: does not publish output or wake a session switched during exec", async () => {
    type ExecResult = {
      stdout: string;
      stderr: string;
      code: number;
      killed: boolean;
    };
    let resolveExec: ((result: ExecResult) => void) | undefined;
    const execDeferred = new Promise<ExecResult>((resolve) => {
      resolveExec = resolve;
    });
    const h = makeHarness({ execDeferred });
    const job = h.store.create({
      name: "slow-ci",
      prompt: "review the result",
      action: "shell",
      command: "slow-check",
      wakeOn: "always",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);

    const wave = h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.execCalls).toHaveLength(1);
    h.setSessionId("session-b");
    if (!resolveExec) throw new Error("exec did not start");
    resolveExec({ stdout: "done", stderr: "", code: 0, killed: false });
    await wave;

    expect(h.sent).toHaveLength(0);
    expect(h.customMessages).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
    const updated = h.store.get(job.id, h.project, "session-b")!;
    expect(updated.lastStatus).toBe("ok");
    expect(updated.lastShell?.stdout).toBe("done");
  });

  it("shell: does not wake on success when wakeOn=failure", async () => {
    const h = makeHarness({ execResult: { code: 0 } });
    const job = h.store.create({
      name: "ci",
      prompt: "should not fire",
      action: "shell",
      command: "true",
      wakeOn: "failure",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(0);
    expect(h.privilege.depth()).toBe(0);
  });

  it("shell: records error when exec throws", async () => {
    const h = makeHarness({ execThrows: true });
    const job = h.store.create({
      name: "ci",
      action: "shell",
      command: "true",
      wakeOn: "never",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("error");
    expect(h.store.get(job.id, h.project)?.lastError).toContain("exec boom");
  });

  it("shell wakeOn=success wakes the agent on green", async () => {
    const h = makeHarness({ execResult: { code: 0, stdout: "ok" } });
    const job = h.store.create({
      name: "ci",
      action: "shell",
      command: "true",
      wakeOn: "success",
      prompt: "summarize the green run",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("shellStatus: success");
    expect(h.privilege.depth()).toBe(1);
  });

  it("shell wakeOn=always with no follow-up text uses generic review prompt", async () => {
    const h = makeHarness({ execResult: { code: 0 } });
    const job = h.store.create({
      name: "ci",
      action: "shell",
      command: "npm test",
      wakeOn: "always",
      tier: "mutate",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.content).toContain("Review this scheduled shell");
  });

  it("notify logs to console when hasUI is false", async () => {
    const h = makeHarness({ hasUI: false });
    const job = h.store.create({
      name: "stretch",
      prompt: "stand up",
      action: "notify",
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });
    h.forceDue(job.id);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    expect(spy).toHaveBeenCalled();
    expect(h.store.get(job.id, h.project)?.lastStatus).toBe("ok");
    spy.mockRestore();
  });
});

describe("ScheduleRunner — termination (once / maxRuns)", () => {
  it("once job fires exactly once then auto-disables", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "reminder",
      prompt: "stand up",
      action: "notify",
      schedule: parseSchedule("in 5m"),
      scope: "global",
    });
    h.forceDue(job.id);

    await h.runner.fireDue(h.ctx, { source: "session_start" });
    const after1 = h.store.get(job.id, h.project)!;
    expect(after1.runCount).toBe(1);
    expect(after1.enabled).toBe(false);
    expect(after1.terminated).toBe("once");

    // Force due again — terminated/disabled jobs are not picked up by dueJobs.
    h.store.upsert({ ...after1, nextRunAt: T0 });
    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.store.get(job.id, h.project)?.runCount).toBe(1); // no second fire
  });

  it("maxRuns terminates the job after the threshold", async () => {
    const h = makeHarness();
    const job = h.store.create({
      name: "poll",
      prompt: "check",
      action: "notify",
      maxRuns: 2,
      schedule: parseSchedule("every 1h"),
      scope: "global",
    });

    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    let row = h.store.get(job.id, h.project)!;
    expect(row.runCount).toBe(1);
    expect(row.terminated).toBeNull();

    // First fire advanced nextRunAt to T0+1h naturally; just advance the clock.
    h.setClock(new Date("2025-01-01T01:00:00.000Z"));
    await h.runner.fireDue(h.ctx, { source: "tick" });
    row = h.store.get(job.id, h.project)!;
    expect(row.runCount).toBe(2);
    expect(row.terminated).toBe("maxRuns");
    expect(row.enabled).toBe(false);

    // Subsequent due no longer fires.
    h.forceDue(job.id);
    h.setClock(new Date("2025-01-01T02:00:00.000Z"));
    await h.runner.fireDue(h.ctx, { source: "tick" });
    expect(h.store.get(job.id, h.project)?.runCount).toBe(2);
  });

  it("once job that errors still terminates (one attempt consumed)", async () => {
    const h = makeHarness({ sendThrows: true });
    const job = h.store.create({
      name: "once",
      prompt: "p",
      schedule: parseSchedule("in 5m"),
      scope: "global",
    });
    h.forceDue(job.id);
    await h.runner.fireDue(h.ctx, { source: "session_start" });
    const row = h.store.get(job.id, h.project)!;
    expect(row.lastStatus).toBe("error");
    expect(row.terminated).toBe("once");
  });
});
