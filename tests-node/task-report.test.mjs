import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("dist/agent-workflow.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-report-"));
  const repo = join(root, "repo");
  const task = join(root, "20260101-000000-report");
  mkdirSync(repo);
  mkdirSync(task);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "report@example.test");
  git("config", "user.name", "Report fixture");
  writeFileSync(join(repo, "app.txt"), "original\n");
  git("add", "app.txt");
  git("commit", "-qm", "fixture");
  const md = "# Report\n\n## Goal\n\nVerify evidence display.\n\n## Scope\n\nOnly this fixture.\n\n## Completion criteria\n\n- report matches the runtime\n\n### Acceptance cases\n\n- **AC1** observable result\n  - Given a runtime receipt\n  - When the report is rendered\n  - Then its validity agrees with the gate\n  - Verify: `node -e 0`\n";
  writeFileSync(join(task, "task.md"), md);
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8", input });
  const init = run(["task-init", "--task-path", task, "--state-root", join(root, "state")], JSON.stringify({ code_change: false, managed_change: false }));
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const receipt = (exitCode = 0) => run(["evidence-run", "--task-path", task, "--requirement-id", "acceptance.AC1", "--cwd", repo, "--summary", "observed | result\n<example>", "--", process.execPath, "-e", `process.exit(${exitCode})`]);
  const report = () => {
    const before = readFileSync(join(task, "task.json"), "utf8");
    const result = run(["task-report", "--task-path", task]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(task, "task.json"), "utf8"), before);
    return result.stdout;
  };
  const gate = () => JSON.parse(run(["task-gate", "--task-path", task]).stdout);
  return { root, repo, task, run, receipt, report, gate, md };
}

test("report shows executed command, cwd, exit code and valid evidence without writing state", () => {
  const f = fixture();
  const result = f.receipt();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = f.report();
  assert.match(report, /\| acceptance\.AC1 \| .*process\.exit\(0\).* \| .*repo \| 0 \| PASS \| VALID \|/);
  assert.ok(report.includes(f.repo), report);
  assert.match(report, /observed &#124; result<br>&lt;example&gt;/);
  assert.equal(f.gate().valid, true);
});

test("a later failure supersedes an older success in both report and gate", () => {
  const f = fixture();
  assert.equal(f.receipt().status, 0);
  assert.notEqual(f.receipt(7).status, 0);
  const report = f.report();
  assert.match(report, /\| 0 \| PASS \| SUPERSEDED \|/);
  assert.match(report, /\| 7 \| FAIL \| INVALID \|/);
  assert.equal(f.gate().valid, false);
  assert.match(report, /required evidence is not recorded\/passed: acceptance\.AC1/);
});

for (const change of ["delivery", "intent"]) {
  test(`report and gate reject evidence after ${change} changes`, () => {
    const f = fixture();
    assert.equal(f.receipt().status, 0);
    if (change === "delivery") writeFileSync(join(f.repo, "app.txt"), "changed\n");
    else writeFileSync(join(f.task, "task.md"), f.md.replace("Verify evidence display.", "Verify another goal."));
    const report = f.report();
    assert.match(report, /\| 0 \| PASS \| INVALID \|/);
    const gate = f.gate();
    assert.equal(gate.valid, false);
    const reason = gate.errors.find((error) => change === "delivery" ? error.includes("execution evidence is stale") : error.includes("different intent"));
    assert.ok(reason, JSON.stringify(gate));
    assert.ok(report.includes(reason), report);
  });
}

test("report renders no evidence without presenting a passing receipt", () => {
  const f = fixture();
  assert.match(f.report(), /\| \(none\) \|/);
  assert.equal(f.gate().valid, false);
});

test("old attested and legacy records keep their status and note without claiming a failed execution", () => {
  const f = fixture();
  assert.equal(f.receipt().status, 0);
  const path = join(f.task, "task.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const analysis = { ...state.evidence[0], evidence_kind: "analysis", trust_level: "attested" };
  for (const key of ["command", "cwd", "exit_code", "output_digest", "delivery_mode", "delivery_base", "delivery_paths", "delivery_fingerprint"]) delete analysis[key];
  state.evidence = [analysis, { kind: "legacy-unverified", status: "needs_reverification", note: "Imported claim needs a new run." }];
  writeFileSync(path, JSON.stringify(state));
  const report = f.report();
  assert.match(report, /\| NOT EXECUTED \| INVALID \|/);
  assert.match(report, /\| UNVERIFIED \| INVALID \|/);
  assert.match(report, /recorded status: needs_reverification/);
  assert.match(report, /Imported claim needs a new run\./);
  assert.equal(f.gate().valid, false);
});

for (const exitCode of [null, undefined, "0"]) {
  test(`an invalid exit code (${String(exitCode)}) is never a passing execution`, () => {
    const f = fixture();
    assert.equal(f.receipt().status, 0);
    const path = join(f.task, "task.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.evidence[0].exit_code = exitCode;
    writeFileSync(path, JSON.stringify(state));
    assert.match(f.report(), /\| UNVERIFIED \| INVALID \|/);
    assert.equal(f.gate().valid, false);
  });
}

test("report uses one intent read for its table and gate even if the file changes after that read", () => {
  const f = fixture();
  assert.equal(f.receipt().status, 0);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const target = ${JSON.stringify(join(f.task, "task.md"))};
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(path, ...args) {
      const value = originalRead.call(this, path, ...args);
      if (String(path) === target && ++reads === 1) fs.writeFileSync(target, String(value).replace('Verify evidence display.', 'Another goal.'));
      return value;
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(cli)}, 'task-report', '--task-path', ${JSON.stringify(f.task)}, '--repo-root', ${JSON.stringify(f.repo)}];
    await import(pathToFileURL(${JSON.stringify(cli)}).href);
    console.error('INTENT_READS:' + reads);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: f.repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /INTENT_READS:1/);
  assert.match(result.stdout, /\| PASS \| VALID \|/);
  assert.match(result.stdout, /- valid: PASS/);
  assert.equal(f.gate().valid, false, "a later independent evaluation sees the changed intent");
});

for (const observation of ["missing", "failed", "old intent"]) {
  test(`non-code gate does not scan delivery for ${observation} evidence`, () => {
    const f = fixture();
    if (observation === "failed") assert.notEqual(f.receipt(7).status, 0);
    if (observation === "old intent") {
      assert.equal(f.receipt().status, 0);
      writeFileSync(join(f.task, "task.md"), f.md.replace("Verify evidence display.", "Another goal."));
    }
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const originalSpawn = cp.spawnSync;
      let scans = 0;
      cp.spawnSync = function(command, args, ...rest) {
        if (command === 'git' && (args.includes('--binary') || args.includes('--untracked-files=all'))) scans++;
        return originalSpawn.call(this, command, args, ...rest);
      };
      syncBuiltinESMExports();
      process.on('exit', () => console.error('DELIVERY_SCANS:' + scans));
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'task-gate', '--task-path', ${JSON.stringify(f.task)}, '--repo-root', ${JSON.stringify(f.repo)}];
      await import(pathToFileURL(${JSON.stringify(cli)}).href);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: f.repo, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, false);
    assert.match(result.stderr, /DELIVERY_SCANS:0/);
  });
}
