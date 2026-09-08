// Hook-only entrypoint. The guards run on every tool call, and bundling them with the rest of the
// CLI made each run pay for loading installer, lifecycle, knowledge and policy code it never calls.
import { option, parseArgs, stateRoot, stdinJson } from "./core.js";
import { clearSkillProof, recordSkillRead, runGuard } from "./hooks.js";

const [command, ...rest] = process.argv.slice(2);
if (command !== "git-guard" && command !== "skill-guard") {
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
    // A hook that cannot read its payload still has to answer, so an unreadable stdin becomes an
    // empty event rather than an exception the platform would read as "no opinion".
    let payload = {}; try { payload = stdinJson(); } catch { payload = {}; }
    const platform = option(parsed.values, "platform", "Codex");
    const event = option(parsed.values, "event", "PreToolUse");
    const root = option(parsed.values, "state-root", stateRoot());
    if (command === "skill-guard" && event === "PostToolUse") recordSkillRead(platform, payload, root);
    if (command === "skill-guard" && event === "SessionEnd") clearSkillProof(platform, payload, root);
    runGuard(command === "git-guard" ? "git" : "skill", platform, event, payload, root);
  }
}
