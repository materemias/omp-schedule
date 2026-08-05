/**
 * Detect whether the current pi process was launched with an initial user
 * prompt (e.g. `pi "check this and that"` or `pi -p "…"`).
 *
 * Only the process-start session should skip due-job firing. Later
 * session_start reasons (new / resume / fork) must not inherit argv forever.
 */

/** OMP 17.2.9 flags that consume the following argv token. */
const VALUE_FLAGS = new Set([
  "--cwd",
  "--config",
  "--add-dir",
  "--mode",
  "--fork",
  "--provider",
  "--model",
  "--smol",
  "--slow",
  "--plan",
  "--prewalk-into",
  "--plan-yolo-into",
  "--max-time",
  "--service-tier",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--provider-session-id",
  "--prompt-cache-key",
  "--session-dir",
  "--models",
  "--tools",
  "--thinking",
  "--export",
  "--hook",
  "--extension",
  "-e",
  "--plugin-dir",
  "--skills",
  "--approval-mode",
  "--profile",
  "--alias",
]);

const OPTIONAL_VALUE_FLAGS = new Set(["--resume", "-r", "--session"]);

/**
 * Returns true when argv contains one or more initial message/file prompts.
 * Safe to call with process.argv; swallows parse errors and treats them as
 * "no prompt" so a bad flag never blocks the extension from loading.
 */
export function hasCliInitialPrompt(argv: string[] = process.argv): boolean {
  const userArgs = argv.slice(2);
  let positionalOnly = false;

  for (let i = 0; i < userArgs.length; i += 1) {
    const arg = userArgs[i] ?? "";
    if (positionalOnly) return true;
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg.startsWith("@")) return true;
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (OPTIONAL_VALUE_FLAGS.has(arg)) {
      const next = userArgs[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") return true;
  }

  return false;
}

/**
 * Whether this session_start should suppress due-job auto-fire because of
 * a CLI initial prompt.
 *
 * Only applies to reason === "startup". `/new` and `/resume` must still
 * process due jobs even if the process was originally launched with a message.
 */
export function shouldSkipDueOnSessionStart(
  reason: string,
  hasPrompt: () => boolean = hasCliInitialPrompt,
): boolean {
  return reason === "startup" && hasPrompt();
}
