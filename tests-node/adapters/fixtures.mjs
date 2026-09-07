// One canonical operation, expressed as the raw hook payload each platform actually sends.
// Claude and Codex both speak the Anthropic-style shape (tool_name/tool_input); Antigravity speaks
// toolCall.name/toolCall.args with its own tool names (view_file/run_command/replace_file_content/
// write_to_file), its own path key (AbsolutePath/TargetFile) and conversationId instead of
// session_id. normalizeHookEvent() in src/hooks.ts is what has to reconcile them into one
// CanonicalHookEvent — these fixtures are the input side of that contract, so they have to stay the
// payloads the platforms really send rather than a shape that merely happens to normalize.
const ANTIGRAVITY_CONVERSATION = "conversation-fixture";
const ANTIGRAVITY_WORKSPACE = process.cwd();

function anthropicStyle(toolName, args) { return { tool_name: toolName, tool_input: args }; }
function antigravityStyle(toolName, args) {
  return { conversationId: ANTIGRAVITY_CONVERSATION, workspacePaths: [ANTIGRAVITY_WORKSPACE], toolCall: { name: toolName, args } };
}

export const OPERATIONS = {
  safe_read: {
    guard: "skill-guard",
    expectDeny: false,
    payloads: {
      Claude: anthropicStyle("read_file", { file_path: "README.md" }),
      Codex: anthropicStyle("read_file", { file_path: "README.md" }),
      Antigravity: antigravityStyle("view_file", { AbsolutePath: `${ANTIGRAVITY_WORKSPACE}/README.md` })
    }
  },
  safe_git_status: {
    guard: "git-guard",
    expectDeny: false,
    payloads: {
      Claude: anthropicStyle("bash", { command: "git status" }),
      Codex: anthropicStyle("bash", { command: "git status" }),
      Antigravity: antigravityStyle("run_command", { CommandLine: "git status", Cwd: ANTIGRAVITY_WORKSPACE })
    }
  },
  // A directly parsed, unwrapped git mutation is deferred to the platform's own ask-for-approval
  // flow rather than hard-denied here: the user sees the exact command and approves it before it
  // runs, instead of being told to type it themselves.
  mutating_git_reset: {
    guard: "git-guard",
    expectDeny: false,
    payloads: {
      Claude: anthropicStyle("bash", { command: "git reset --hard" }),
      Codex: anthropicStyle("bash", { command: "git reset --hard" }),
      Antigravity: antigravityStyle("run_command", { CommandLine: "git reset --hard", Cwd: ANTIGRAVITY_WORKSPACE })
    }
  },
  task_json_direct_write: {
    guard: "skill-guard",
    expectDeny: true,
    denyContains: "task-guard",
    payloads: {
      Claude: anthropicStyle("edit", { file_path: "tasks/20260101-000000-demo/task.json" }),
      Codex: anthropicStyle("edit", { file_path: "tasks/20260101-000000-demo/task.json" }),
      Antigravity: antigravityStyle("replace_file_content", { TargetFile: "tasks/20260101-000000-demo/task.json" })
    }
  },
  unlocatable_mutation: {
    guard: "skill-guard",
    expectDeny: true,
    denyContains: "denied fail-closed",
    payloads: {
      Claude: anthropicStyle("write_file", {}),
      Codex: anthropicStyle("write_file", {}),
      Antigravity: antigravityStyle("write_to_file", {})
    }
  }
};
