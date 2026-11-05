import { afterAll, afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "./schedule.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-schedule-test-"));
const dir = path.join(root, "schedule");

const HOUR = 3_600_000;
const ARM_MS = 2; // activation defers to the next tick, and arming an overdue job to the one after
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
	status: (string | undefined)[];
	command(args: string): Promise<unknown>;
	tool(params: Record<string, string>): Promise<ToolResult>;
	switchTo(next: string): void;
	shutdown(): void;
};

const live: Harness[] = [];

function start(session: string, opts: { idle?: boolean; hasUI?: boolean } = {}): Harness {
	const handlers: Record<string, Handler> = {};
	const sent: Harness["sent"] = [];
	const notes: Harness["notes"] = [];
	const status: Harness["status"] = [];
	let execute: Handler | undefined;
	let idle = opts.idle ?? true;
	let current = session;
	const ctx = {
		hasUI: opts.hasUI ?? true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => current },
		ui: {
			notify: (message: string, type: string) => notes.push([type, message]),
			setStatus: (_key: string, value?: string) => status.push(value),
		},
	};
	extension({
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		registerCommand: (_name: string, command: { handler: Handler }) => {
			handlers.command = command.handler;
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
		status,
		command: async (args) => handlers.command(args, ctx),
		tool: async (params) => (await execute?.("id", params, undefined, undefined, ctx)) as ToolResult,
		switchTo: (next) => {
			current = next;
			handlers.session_switch({}, ctx);
			vi.advanceTimersByTime(ARM_MS);
		},
		shutdown: () => handlers.session_shutdown(),
	};
	handlers.session_start({}, ctx);
	vi.advanceTimersByTime(ARM_MS);
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
	expect(t.status.at(-1)).toBeUndefined();
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
	expect(readJobs("a")[0].dueAt).toBe(Date.now() + HOUR);
	vi.advanceTimersByTime(HOUR);
	expect(t.sent).toHaveLength(2);
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
	for (const bad of ["10 no unit", "5x bad unit", "0s zero", "every 30s too fast", "30m"]) {
		await t.command(bad);
		expect(t.notes.at(-1)?.[0]).toBe("error");
	}
	expect(readJobs("a")).toHaveLength(1);
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
	expect(second.notes.at(-1)?.[1]).toContain("every 1h  keep going");
	expect(second.status.at(-1)).toContain("⏰");
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
