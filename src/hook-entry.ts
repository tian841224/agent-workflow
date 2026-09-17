// Hook-only entrypoint. The guards run on every tool call, and bundling them with the rest of the
// CLI made each run pay for loading installer, lifecycle, knowledge and policy code it never calls.
import { option, parseArgs, stateRoot, stdinJson } from "./core.js";
import { runGuard } from "./hooks.js";
import { runLocaleLint } from "./locale-hooks.js";

const [command, ...rest] = process.argv.slice(2);
const HOOK_COMMANDS = new Set(["git-guard", "locale-lint"]);
if (!HOOK_COMMANDS.has(command)) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exitCode = 2;
} else {
  const parsed = parseArgs(rest);
  const allowed = new Set(["platform", "event", "state-root"]);
  const unknown = [...parsed.values.keys()].filter((key) => !allowed.has(key));
  if (unknown.length) {
    process.stderr.write(`Unknown option(s) for ${command}: ${unknown.map((key) => `--${key}`).join(", ")}\n`);
    process.exitCode = 2;
  } else {
    const root = option(parsed.values, "state-root", stateRoot());
    // A hook that cannot read its payload still has to answer, so an unreadable stdin becomes an
    // empty event rather than an exception the platform would read as "no opinion".
    let payload = {}; try { payload = stdinJson(); } catch { payload = {}; }
    if (command === "locale-lint") runLocaleLint(payload, root, option(parsed.values, "platform", "Claude"));
    else runGuard(option(parsed.values, "platform", "Codex"), option(parsed.values, "event", "PreToolUse"), payload, root);
  }
}
