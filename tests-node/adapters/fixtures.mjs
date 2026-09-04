// One canonical operation, expressed as the raw hook payload each platform actually sends.
// Claude and Codex both speak the Anthropic-style shape (tool_name/tool_input); Antigravity speaks
// toolCall.name/toolCall.args. normalizeHookEvent() in src/hooks.ts is what has to reconcile them
// into one CanonicalHookEvent — these fixtures are the input side of that contract.
function anthropicStyle(toolName, args) { return { tool_name: toolName, tool_input: args }; }
function antigravityStyle(toolName, args) { return { toolCall: { name: toolName, args } }; }

export const OPERATIONS = {
  safe_read: {
    guard: "skill-guard",
    expectDeny: false,
    payloads: {
      Claude: anthropicStyle("read_file", { file_path: "README.md" }),
      Codex: anthropicStyle("read_file", { file_path: "README.md" }),
      Antigravity: antigravityStyle("read_file", { file_path: "README.md" })
    }
  },
  safe_git_status: {
    guard: "git-guard",
    expectDeny: false,
    payloads: {
      Claude: anthropicStyle("bash", { command: "git status" }),
      Codex: anthropicStyle("bash", { command: "git status" }),
      Antigravity: antigravityStyle("run_terminal_command", { CommandLine: "git status" })
    }
  },
  unsafe_git_reset: {
    guard: "git-guard",
    expectDeny: true,
    denyContains: "git-guard",
    payloads: {
      Claude: anthropicStyle("bash", { command: "git reset --hard" }),
      Codex: anthropicStyle("bash", { command: "git reset --hard" }),
      Antigravity: antigravityStyle("run_terminal_command", { CommandLine: "git reset --hard" })
    }
  },
  task_json_direct_write: {
    guard: "skill-guard",
    expectDeny: true,
    denyContains: "task-guard",
    payloads: {
      Claude: anthropicStyle("edit", { file_path: "tasks/20260101-000000-demo/task.json" }),
      Codex: anthropicStyle("edit", { file_path: "tasks/20260101-000000-demo/task.json" }),
      Antigravity: antigravityStyle("edit_file", { file_path: "tasks/20260101-000000-demo/task.json" })
    }
  },
  unlocatable_mutation: {
    guard: "skill-guard",
    expectDeny: true,
    denyContains: "denied fail-closed",
    payloads: {
      Claude: anthropicStyle("write_file", {}),
      Codex: anthropicStyle("write_file", {}),
      Antigravity: antigravityStyle("write_file", {})
    }
  }
};
