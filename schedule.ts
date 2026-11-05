// omp-schedule: send a prompt into this same session after a delay or on a fixed interval, from the
// /schedule command or the agent's `schedule` tool.
//
// A job belongs to the session that created it and fires only there, as a plain user message: no
// wrapper, same context, every tool. A busy agent gets it as a follow-up.
// Jobs live in ~/.omp/agent/schedule/<sessionId>.json, so they survive /restart and resume.
// A closed session fires nothing; on resume each overdue job fires once and recurring jobs continue
// from that moment. Forks, branches and handoffs get a new session ID and no jobs.
// Sessions without a UI, such as print mode and subagents, neither schedule nor fire.
// @ts-nocheck

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR = path.join(os.homedir(), ".omp", "agent", "schedule");
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires immediately above ~24.8 days
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const MIN_EVERY_MS = 60_000;
const MAX_DURATION_MS = 365 * 86_400_000; // formatTime shows no year
// OMP restores the transcript and draws the chat only after the session hooks return, with startup
// I/O and other extensions' async handlers in between, and no event marks the end. A prompt sent
// before that would be lost, so overdue jobs wait this long after a session becomes active.
export const RESUME_GRACE_MS = 2000;
const USAGE = "Usage: /schedule 30m <prompt> | /schedule every 2h <prompt> | /schedule cancel <id|all>";

type Job = { id: number; prompt: string; everyMs?: number; dueAt: number };

function parseDuration(text: string): number | undefined {
	if (!/^(\d+[dhms])+$/.test(text)) return undefined;
	let ms = 0;
	for (const [, n, unit] of text.matchAll(/(\d+)([dhms])/g)) ms += Number(n) * UNIT_MS[unit];
	return ms > 0 && ms <= MAX_DURATION_MS ? ms : undefined;
}

function formatDuration(ms: number): string {
	let rest = ms;
	let out = "";
	for (const [unit, size] of Object.entries(UNIT_MS)) {
		const n = Math.floor(rest / size);
		if (n) out += `${n}${unit}`;
		rest -= n * size;
	}
	return out || "0s";
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hm = d.toTimeString().slice(0, 5);
	return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}.${d.getDate()}. ${hm}`;
}

function isJob(j): j is Job {
	return (
		Number.isInteger(j?.id) &&
		typeof j.prompt === "string" &&
		Number.isFinite(j.dueAt) &&
		(j.everyMs === undefined || j.everyMs > 0)
	);
}

function load(file: string): Job[] {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(data) ? data.filter(isJob) : [];
	} catch {
		return [];
	}
}

function save(file: string, jobs: Job[]): void {
	if (jobs.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(jobs, null, 2));
	fs.renameSync(`${file}.tmp`, file);
}

export default function (pi, dir = DIR) {
	let ctx; // context of the live session
	let sessionId: string | undefined; // session whose jobs are loaded
	let file: string; // that session's job file
	let jobs: Job[] = [];
	let lastId = 0; // ids stay unique within a run, so a stale listing can't cancel a newer job
	let timer;

	function disarm() {
		if (timer) ctx?.clearTimer(timer);
		timer = undefined;
	}

	function arm() {
		disarm();
		const next = jobs.reduce((a, j) => (a && a.dueAt <= j.dueAt ? a : j), undefined);
		const more = jobs.length > 1 ? ` +${jobs.length - 1}` : "";
		ctx.ui.setStatus("schedule", next ? `⏰ ${formatTime(next.dueAt)}${more}` : undefined);
		if (next) timer = ctx.setTimeout(fireDue, Math.min(Math.max(next.dueAt - Date.now(), 0), MAX_TIMER_MS));
	}

	function fireDue() {
		timer = undefined;
		if (!ctx || ctx.sessionManager.getSessionId() !== sessionId) return;
		const now = Date.now();
		const due = jobs.filter((j) => j.dueAt <= now);
		if (due.length === 0) {
			arm(); // the wait was capped at MAX_TIMER_MS
			return;
		}
		// An idle agent starts a turn on the first prompt; later ones queue behind it.
		let busy = !ctx.isIdle();
		for (const job of due) {
			pi.sendUserMessage(job.prompt, busy ? { deliverAs: "followUp" } : undefined);
			busy = true;
			if (job.everyMs) job.dueAt = now + job.everyMs;
			else jobs = jobs.filter((j) => j !== job);
		}
		// A failed save reaches omp's extension error channel; the other jobs must still fire.
		try {
			save(file, jobs);
		} finally {
			arm();
		}
	}

	function activate(c) {
		if (!c.hasUI) return;
		disarm();
		ctx = c;
		sessionId = c.sessionManager.getSessionId();
		file = path.join(dir, `${sessionId}.json`);
		jobs = load(file);
		lastId = Math.max(0, ...jobs.map((j) => j.id));
		timer = ctx.setTimeout(arm, RESUME_GRACE_MS);
	}

	function ensureActive(c) {
		// A print or subagent session ends with its task, so a job created there would never fire.
		if (!c.hasUI) throw new Error("schedule needs an interactive session.");
		if (c.sessionManager.getSessionId() !== sessionId) activate(c);
	}

	function addJob(prompt: string, duration: string, repeat: boolean): string {
		const ms = parseDuration(duration);
		if (!ms) throw new Error(`Bad duration "${duration}": use 30s, 10m, 2h, 1d or 1h30m, up to 365d.`);
		if (repeat && ms < MIN_EVERY_MS) throw new Error("Interval must be at least 1m.");
		const job: Job = {
			id: lastId + 1,
			prompt,
			everyMs: repeat ? ms : undefined,
			dueAt: Date.now() + ms,
		};
		save(file, [...jobs, job]);
		lastId = job.id;
		jobs.push(job);
		arm();
		return `#${job.id} at ${formatTime(job.dueAt)}${repeat ? `, then every ${formatDuration(ms)}` : ""}`;
	}

	function cancelJobs(target: string): string {
		const kept = target === "all" ? [] : jobs.filter((j) => String(j.id) !== target.replace(/^#/, ""));
		const cancelled = jobs.length - kept.length;
		if (cancelled === 0) throw new Error(`No job ${target}.`);
		save(file, kept);
		jobs = kept;
		arm();
		return `Cancelled ${cancelled} job(s).`;
	}

	function listJobs(): string | undefined {
		if (jobs.length === 0) return undefined;
		return jobs
			.map((j) => {
				const repeat = j.everyMs ? `every ${formatDuration(j.everyMs)}` : "once";
				return `#${j.id}  ${formatTime(j.dueAt)}  ${repeat}  ${j.prompt.replace(/\s+/g, " ").slice(0, 80)}`;
			})
			.join("\n");
	}

	pi.on("session_start", (_event, c) => activate(c));
	pi.on("session_switch", (_event, c) => activate(c));
	pi.on("session_branch", (_event, c) => activate(c));
	pi.on("session_shutdown", () => {
		disarm();
		ctx = undefined;
	});

	pi.registerCommand("schedule", {
		description: "Send a prompt to this session later: /schedule 30m <prompt> | every 2h <prompt> | cancel <id|all>",
		handler: async (args: string, c) => {
			try {
				ensureActive(c);
				const text = args.trim();
				if (text === "" || text === "list") {
					c.ui.notify(listJobs() ?? `No scheduled jobs in this session.\n${USAGE}`, "info");
					return;
				}
				const cancel = text.match(/^cancel\s+(\S+)$/);
				if (cancel) {
					c.ui.notify(cancelJobs(cancel[1]), "info");
					return;
				}
				const job = text.match(/^(every\s+)?(\S+)\s+(\S[\s\S]*)$/);
				if (!job || job[2] === "every" || job[2] === "cancel") throw new Error(USAGE);
				c.ui.notify(addJob(job[3].trim(), job[2], Boolean(job[1])), "info");
			} catch (err) {
				c.ui.notify(err.message, "error");
			}
		},
	});

	const { Type } = pi.typebox;
	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description:
			"Schedule a prompt into this same session for later: recheck, reminder, or repeating poll. It runs with the full conversation and every tool.\n" +
			"`create` takes `prompt` plus exactly one of `in` and `every`; `cancel` takes `id`.\n" +
			"For a clock time, work out the delay from the current time.\n" +
			"Interactive sessions only. A closed session fires nothing; on resume each overdue job fires once.",
		parameters: Type.Object({
			action: Type.Enum(["create", "list", "cancel"] as const),
			prompt: Type.Optional(
				Type.String({
					description: "Sent verbatim as a user message: the instruction your later self needs. May refer to this conversation.",
				}),
			),
			in: Type.Optional(Type.String({ description: "Fire once after this delay: 30s, 10m, 2h, 1d or 1h30m" })),
			every: Type.Optional(Type.String({ description: "Repeat at this interval, at least 1m, in the same format as `in`" })),
			id: Type.Optional(Type.String({ description: 'Job id, or "all"' })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, c) {
			ensureActive(c);
			const text = runTool(params);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// Strict tool schemas make models send "" for fields they mean to leave out.
	function runTool(params): string {
		const prompt = params.prompt?.trim();
		const delay = params.in?.trim();
		const every = params.every?.trim();
		const id = params.id?.trim();
		switch (params.action) {
			case "list":
				return listJobs() ?? "No scheduled jobs in this session.";
			case "cancel":
				if (!id) throw new Error('cancel needs `id` (a job id or "all").');
				return cancelJobs(id);
			case "create":
				if (!prompt) throw new Error("create needs `prompt`.");
				if (Boolean(delay) === Boolean(every)) throw new Error("create needs exactly one of `in` and `every`.");
				return addJob(prompt, delay || every, Boolean(every));
			default:
				throw new Error(`Unknown action ${params.action}.`);
		}
	}
}
