import { afterAll, afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, { RESUME_GRACE_MS } from "./schedule.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-schedule-test-"));
const dir = path.join(root, "schedule");

const HOUR = 3_600_000;
const ARM_MS = RESUME_GRACE_MS + 2; // the grace, then a tick for each deferred arm of an overdue job
const fakeType = {
	Object: (shape: unknown) => shape,
	Enum: (values: unknown) => values,
	Optional: (schema: unknown) => schema,
	String: () => ({}),
};

type Handler = (...args: unknown[]) => unknown;
type ToolResult = { content: { text: string }[] };
type Harness = {
	sent: [string, string][];
	notes: [string, string][];
	widget: (string | undefined)[];
	errors: unknown[];
	dialog: { rows: string[]; details: (string | undefined)[]; pick: (rows: string[]) => string | undefined; confirm: boolean };
	command(args: string): Promise<unknown>;
	complete(args: string): { value: string }[] | null;
	tool(params: Record<string, string>): Promise<ToolResult>;
	switchTo(next: string): void;
	shutdown(): void;
};

const live: Harness[] = [];

function start(session: string, opts: { idle?: boolean; hasUI?: boolean; settle?: boolean } = {}): Harness {
	const handlers: Record<string, Handler> = {};
	const sent: Harness["sent"] = [];
	const notes: Harness["notes"] = [];
	const widget: Harness["widget"] = [];
	const errors: Harness["errors"] = [];
	const dialog: Harness["dialog"] = { rows: [], details: [], pick: () => undefined, confirm: true };
	let execute: Handler | undefined;
	let idle = opts.idle ?? true;
	let current = session;
	const ctx = {
		hasUI: opts.hasUI ?? true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => current },
		ui: {
			notify: (message: string, type: string) => notes.push([type, message]),
			select: async (_title: string, rows: (string | { label: string; description: string })[]) => {
				dialog.rows = rows.map((row) => (typeof row === "string" ? row : row.label));
				dialog.details = rows.map((row) => (typeof row === "string" ? undefined : row.description));
				return dialog.pick(dialog.rows);
			},
			confirm: async () => dialog.confirm,
			setWidget: (_key: string, lines?: string[]) => widget.push(lines?.[0]),
		},
		// omp's managed timers route a throwing callback to its error channel.
		setTimeout: (callback: () => void, ms: number) =>
			setTimeout(() => {
				try {
					callback();
				} catch (err) {
					errors.push(err);
				}
			}, ms),
		clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
	};
	extension({
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		registerCommand: (_name: string, command: { handler: Handler; getArgumentCompletions: Handler }) => {
			handlers.command = command.handler;
			handlers.complete = command.getArgumentCompletions;
		},
		registerTool: (definition: { execute: Handler }) => {
			execute = definition.execute;
		},
		sendUserMessage: (prompt: string, options?: { deliverAs?: string }) => {
			sent.push([prompt, options?.deliverAs ?? "prompt"]);
			idle = false;
		},
		typebox: { Type: fakeType },
	}, dir);
	const harness: Harness = {
		sent,
		notes,
		widget,
		errors,
		dialog,
		command: async (args) => handlers.command(args, ctx),
		complete: (args) => handlers.complete(args) as { value: string }[] | null,
		tool: async (params) => (await execute?.("id", params, undefined, undefined, ctx)) as ToolResult,
		switchTo: (next) => {
			current = next;
			handlers.session_switch({}, ctx);
			vi.advanceTimersByTime(ARM_MS);
		},
		shutdown: () => handlers.session_shutdown(),
	};
	handlers.session_start({}, ctx);
	if (opts.settle !== false) vi.advanceTimersByTime(ARM_MS);
	live.push(harness);
	return harness;
}

const jobFile = (session: string) => path.join(dir, `${session}.json`);
const readJobs = (session: string) => JSON.parse(fs.readFileSync(jobFile(session), "utf8"));
const writeJobs = (session: string, jobs: unknown[]) => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(jobFile(session), JSON.stringify(jobs));
};

beforeEach(() => {
	vi.useFakeTimers();
	fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
	for (const harness of live.splice(0)) harness.shutdown();
	vi.useRealTimers();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("a job fires the prompt verbatim in its session and then disappears", async () => {
	const t = start("a");
	await t.command("1s  line one\nline two ");
	vi.advanceTimersByTime(999);
	expect(t.sent).toEqual([]);
	vi.advanceTimersByTime(1);
	expect(t.sent).toEqual([["line one\nline two", "prompt"]]);
	expect(fs.existsSync(jobFile("a"))).toBe(false);
	expect(t.widget.at(-1)).toBeUndefined();
});

test("another session never fires or lists a session's jobs", async () => {
	writeJobs("a", [{ id: 1, prompt: "for a", dueAt: Date.now() - HOUR }]);
	const t = start("b");
	await t.command("");
	expect(t.sent).toEqual([]);
	expect(t.notes.at(-1)?.[1]).toContain("No scheduled jobs");
	expect(readJobs("a")).toHaveLength(1);
});

test("switching away keeps the job waiting, and it fires on return", async () => {
	const t = start("a");
	await t.command("1s come back");
	t.switchTo("b");
	vi.advanceTimersByTime(2000);
	expect(t.sent).toEqual([]);
	t.switchTo("a");
	expect(t.sent).toEqual([["come back", "prompt"]]);
});

test("due jobs start a turn when idle and queue behind it", () => {
	const past = Date.now() - HOUR;
	writeJobs("a", [
		{ id: 1, prompt: "first", dueAt: past },
		{ id: 2, prompt: "second", dueAt: past },
	]);
	const t = start("a");
	expect(t.sent).toEqual([
		["first", "prompt"],
		["second", "followUp"],
	]);
});

test("a job due while the agent works arrives as a follow-up", () => {
	writeJobs("a", [{ id: 1, prompt: "later", dueAt: Date.now() - HOUR }]);
	const t = start("a", { idle: false });
	expect(t.sent).toEqual([["later", "followUp"]]);
});

test("an overdue recurring job fires once and continues from now", () => {
	writeJobs("a", [{ id: 1, prompt: "tick", everyMs: HOUR, dueAt: Date.now() - 5 * HOUR }]);
	const t = start("a");
	expect(t.sent).toEqual([["tick", "prompt"]]);
	expect(readJobs("a")[0].dueAt).toBeGreaterThan(Date.now() + HOUR - ARM_MS);
	vi.advanceTimersByTime(HOUR);
	expect(t.sent).toHaveLength(2);
});

test("an overdue job waits out the resume grace, so its prompt lands in the restored transcript", () => {
	writeJobs("a", [{ id: 1, prompt: "late", dueAt: Date.now() - HOUR }]);
	const t = start("a", { settle: false });
	vi.advanceTimersByTime(RESUME_GRACE_MS - 1);
	expect(t.sent).toEqual([]);
	vi.advanceTimersByTime(3);
	expect(t.sent).toEqual([["late", "prompt"]]);
});

test("a session without UI leaves overdue jobs for the interactive session", () => {
	writeJobs("a", [{ id: 1, prompt: "keep me", dueAt: Date.now() - HOUR }]);
	const t = start("a", { hasUI: false });
	vi.advanceTimersByTime(HOUR);
	expect(t.sent).toEqual([]);
	expect(readJobs("a")).toHaveLength(1);
});

test("a malformed job file fires only its valid jobs and never throws in the timer", () => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(jobFile("object"), "{}");
	const object = start("object");
	expect(object.errors).toEqual([]);

	const past = Date.now() - HOUR;
	writeJobs("mixed", [{ id: 1, prompt: "no due time" }, { id: 2, dueAt: past }, { id: 3, prompt: "valid", dueAt: past }]);
	const mixed = start("mixed");
	expect(mixed.sent).toEqual([["valid", "prompt"]]);
	expect(mixed.errors).toEqual([]);
});

test("a failed save reaches the error channel and later jobs still fire", async () => {
	const t = start("a");
	await t.command("1s first");
	await t.command("2s second");
	fs.rmSync(dir, { recursive: true });
	fs.writeFileSync(dir, "a file where the directory should be");
	vi.advanceTimersByTime(2000);
	expect(t.sent.map(([prompt]) => prompt)).toEqual(["first", "second"]);
	expect(t.errors).not.toEqual([]);
});

test("a job that can't be saved is reported and not kept", async () => {
	const t = start("a");
	fs.writeFileSync(dir, "a file where the directory should be");
	await t.command("1s lost");
	expect(t.notes.at(-1)?.[0]).toBe("error");
	vi.advanceTimersByTime(2000);
	expect(t.sent).toEqual([]);
});

test("a job further away than a setTimeout can wait fires on time, not early", async () => {
	const t = start("a");
	await t.command("30d far away");
	vi.advanceTimersByTime(29 * 24 * HOUR);
	expect(t.sent).toEqual([]);
	vi.advanceTimersByTime(24 * HOUR);
	expect(t.sent).toEqual([["far away", "prompt"]]);
});

test("combined durations add up and a bad spec creates nothing", async () => {
	const t = start("a");
	await t.command("1h30m soon");
	expect(readJobs("a")[0].dueAt).toBe(Date.now() + 1.5 * HOUR);
	for (const bad of ["10 no unit", "5x bad unit", "0s zero", "every 30s too fast", "30m", "366d too far", `${"9".repeat(309)}s overflow`]) {
		await t.command(bad);
		expect(t.notes.at(-1)?.[0]).toBe("error");
	}
	for (const incomplete of ["every 2h", "cancel 1 2"]) {
		await t.command(incomplete);
		expect(t.notes.at(-1)?.[1]).toStartWith("Usage:");
	}
	expect(readJobs("a")).toHaveLength(1);
});

test("a cancelled job's id is not reused while the session runs", async () => {
	const t = start("a");
	await t.command("1h one");
	await t.command("2h two");
	await t.command("cancel 2");
	await t.command("3h three");
	expect(readJobs("a").map((j: { id: number }) => j.id)).toEqual([1, 3]);
});

test("cancel removes one job by id, or all of them", async () => {
	const t = start("a");
	await t.command("1h one");
	await t.command("every 2h two");
	await t.command("3h three");
	await t.command("cancel #2");
	expect(readJobs("a").map((j: { prompt: string }) => j.prompt)).toEqual(["one", "three"]);
	await t.command("cancel 9");
	expect(t.notes.at(-1)).toEqual(["error", "No job 9."]);
	await t.command("cancel all");
	expect(fs.existsSync(jobFile("a"))).toBe(false);
	vi.advanceTimersByTime(4 * HOUR);
	expect(t.sent).toEqual([]);
});

test("jobs survive a restart of the session's process", async () => {
	const first = start("a");
	await first.command("every 1h keep going");
	first.shutdown();
	const second = start("a");
	await second.command("");
	expect(second.dialog.rows[0]).toBe("#1  keep going");
	expect(second.dialog.details[0]).toContain("every 1h");
	expect(second.widget.at(-1)).toContain("⏰");
});

test("the row above the composer shows the soonest job from the moment it is scheduled", async () => {
	const t = start("a");
	await t.command("every 2h for 1d check the CI run");
	expect(t.widget.at(-1)).toContain("#1 check the CI run · every 2h until");
	await t.command("1h tell a joke");
	expect(t.widget.at(-1)).toEndWith("#2 tell a joke · once · +1 more");
	await t.command(`1m ${"x".repeat(200)}`);
	expect(t.widget.at(-1)).toEndWith(`#3 ${"x".repeat(49)}… · once · +2 more`);
	await t.command("cancel all");
	expect(t.widget.at(-1)).toBeUndefined();
});

test("the tool schedules into the same session and treats blank fields as absent", async () => {
	const t = start("a");
	const created = await t.tool({ action: "create", prompt: "from the agent", in: "1s", every: "", id: "" });
	expect(created.content[0].text).toStartWith("#1 at");
	vi.advanceTimersByTime(1000);
	expect(t.sent).toEqual([["from the agent", "prompt"]]);
});

test("the tool lists and cancels jobs and rejects an ambiguous create", async () => {
	const t = start("a");
	await t.tool({ action: "create", prompt: "tick", every: "2h" });
	expect((await t.tool({ action: "list" })).content[0].text).toContain("every 2h  tick");
	await expect(t.tool({ action: "create", prompt: "x", in: "1h", every: "1h" })).rejects.toThrow("exactly one");
	await expect(t.tool({ action: "create", prompt: "x" })).rejects.toThrow("exactly one");
	await expect(t.tool({ action: "create", in: "1h" })).rejects.toThrow("prompt");
	await expect(t.tool({ action: "cancel" })).rejects.toThrow("id");
	await t.tool({ action: "cancel", id: "all" });
	expect((await t.tool({ action: "list" })).content[0].text).toContain("No scheduled jobs");
});

test("the tool refuses a session without UI, whose jobs would never fire", async () => {
	const t = start("subagent", { hasUI: false });
	await expect(t.tool({ action: "create", prompt: "x", in: "1h" })).rejects.toThrow("interactive session");
	expect(fs.existsSync(jobFile("subagent"))).toBe(false);
});

test("completions offer units, valid intervals, the session's jobs, and stop once the prompt starts", async () => {
	const t = start("a");
	const values = (args: string) => t.complete(args)?.map((item) => item.value);
	expect(values("2")).toEqual(["2m ", "2h ", "2d ", "2s "]);
	expect(values("1h3")).toEqual(["1h3m ", "1h3d ", "1h3s "]);
	expect(values("every 30")).toEqual(["every 30m ", "every 30h ", "every 30d "]);
	expect(values("400d")).toEqual([]);
	expect(values("c")).toEqual([]);
	expect(values("every 1h ")).toEqual(["every 1h for "]);
	expect(values("every 1h check")).toEqual([]);
	expect(values("every 2h for 1")).toEqual(["every 2h for 1d "]);
	expect(values("every 2h for 3")).toEqual(["every 2h for 3h ", "every 2h for 3d "]);
	expect(t.complete("every 2h for 1d check")).toBeNull();
	await t.command("1h one");
	await t.command("2h two");
	expect(values("c")).toEqual(["cancel ", "cancel all"]);
	expect(values("cancel ")).toEqual(["cancel 1", "cancel 2", "cancel all"]);
	await t.command("cancel 2");
	expect(values("cancel a")).toEqual(["cancel all"]);
	await t.command("2h two");
	expect(values("cancel #3")).toEqual(["cancel 3"]);
	expect(t.complete("30m check the deploy")).toBeNull();
});

test("a `for` window fires its last slot and then ends the job", async () => {
	const t = start("a");
	await t.command("every 1h for 3h tick");
	vi.advanceTimersByTime(3 * HOUR - 1);
	expect(t.sent).toHaveLength(2);
	vi.advanceTimersByTime(1);
	expect(t.sent).toHaveLength(3);
	expect(fs.existsSync(jobFile("a"))).toBe(false);
	vi.advanceTimersByTime(3 * HOUR);
	expect(t.sent).toHaveLength(3);
});

test("a window stops at the last slot inside it", async () => {
	const t = start("a");
	await t.command("every 1h for 2h30m tick");
	vi.advanceTimersByTime(6 * HOUR);
	expect(t.sent).toHaveLength(2);
});

test("a late timer doesn't lose the last slot of a window", () => {
	const now = Date.now();
	writeJobs("a", [{ id: 1, prompt: "tick", everyMs: HOUR, dueAt: now, endsAt: now + HOUR }]);
	const t = start("a"); // fires late, after the resume grace
	expect(t.sent).toHaveLength(1);
	vi.advanceTimersByTime(HOUR);
	expect(t.sent).toHaveLength(2);
	expect(fs.existsSync(jobFile("a"))).toBe(false);
});

test("a window that closed while the session was closed fires nothing and clears the job", () => {
	const now = Date.now();
	writeJobs("a", [
		{ id: 1, prompt: "expired", everyMs: HOUR, dueAt: now - 3 * HOUR, endsAt: now - HOUR },
		{ id: 2, prompt: "last call", everyMs: HOUR, dueAt: now - 2 * HOUR, endsAt: now + HOUR / 2 },
	]);
	const t = start("a");
	expect(t.sent).toEqual([["last call", "prompt"]]);
	expect(fs.existsSync(jobFile("a"))).toBe(false);
});

test("a window that closed a moment before resume fires nothing", () => {
	const now = Date.now();
	writeJobs("a", [{ id: 1, prompt: "too late", everyMs: HOUR, dueAt: now - 1000, endsAt: now - 1000 }]);
	const t = start("a");
	expect(t.sent).toEqual([]);
	expect(fs.existsSync(jobFile("a"))).toBe(false);
});

test("a window survives a restart and shows in the listing", async () => {
	const first = start("a");
	await first.command("every 1h for 1d tick");
	first.shutdown();
	const second = start("a");
	await second.command("");
	expect(second.dialog.details[0]).toContain("until");
	expect(readJobs("a")[0].endsAt).toBeGreaterThan(Date.now());
});

test("the command tells a window from a prompt that starts with for", async () => {
	const t = start("a");
	await t.command("every 1h for each PR, check CI");
	expect(readJobs("a")[0]).toMatchObject({ prompt: "for each PR, check CI" });
	expect(readJobs("a")[0].endsAt).toBeUndefined();
	await t.command("1h for 2h stays a prompt");
	expect(readJobs("a")[1]).toMatchObject({ prompt: "for 2h stays a prompt" });
	for (const bad of ["every 1h for 2x typo", "every 1h for 30m too short", "every 1h for 366d too long"]) {
		await t.command(bad);
		expect(t.notes.at(-1)?.[0]).toBe("error");
	}
	await t.command("every 1h for 2h");
	expect(t.notes.at(-1)?.[1]).toStartWith("Usage:");
	expect(readJobs("a")).toHaveLength(2);
});

test("the tool takes a window with `every` and refuses it without", async () => {
	const t = start("a");
	const created = await t.tool({ action: "create", prompt: "tick", every: "1h", for: "2h" });
	expect(created.content[0].text).toContain("until");
	vi.advanceTimersByTime(4 * HOUR);
	expect(t.sent).toHaveLength(2);
	await expect(t.tool({ action: "create", prompt: "x", in: "1h", for: "2h" })).rejects.toThrow("needs `every`");
	await t.tool({ action: "create", prompt: "open ended", every: "1h", for: "" });
	expect(readJobs("a")[0].endsAt).toBeUndefined();
});

test("the list shows a row per job and cancels only a confirmed pick", async () => {
	const t = start("a");
	await t.command("1h one");
	await t.command("every 2h two");
	await t.command("");
	expect(t.dialog.rows).toHaveLength(3);
	expect(t.dialog.rows[1]).toBe("#2  two");
	expect(t.dialog.details[1]).toContain("every 2h");
	expect(readJobs("a")).toHaveLength(2);

	t.dialog.pick = (rows) => rows[1];
	t.dialog.confirm = false;
	await t.command("list");
	expect(readJobs("a")).toHaveLength(2);

	t.dialog.confirm = true;
	await t.command("");
	expect(readJobs("a").map((j: { prompt: string }) => j.prompt)).toEqual(["one"]);

	await t.command("3h three");
	t.dialog.pick = (rows) => rows.at(-1);
	await t.command("");
	expect(fs.existsSync(jobFile("a"))).toBe(false);
});

test("a job that fired while the list was open is reported as gone", async () => {
	const t = start("a");
	await t.command("1s one");
	t.dialog.pick = (rows) => {
		vi.advanceTimersByTime(1000);
		return rows[0];
	};
	await t.command("");
	expect(t.sent).toEqual([["one", "prompt"]]);
	expect(t.notes.at(-1)).toEqual(["error", "No job 1."]);
});
