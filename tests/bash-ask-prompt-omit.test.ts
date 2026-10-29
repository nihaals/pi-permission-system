import { runTest } from "./test-harness.js";
import { formatAskPrompt } from "../src/permission-prompts.js";
import type { PermissionCheckResult } from "../src/types.js";

function createBashCheck(command: string, matchedPattern?: string): PermissionCheckResult {
  return {
    state: "ask",
    source: "bash",
    toolName: "bash",
    command,
    matchedPattern,
  };
}

runTest("omitted bash command does not contain the command text", () => {
  const heredoc = "bash -lc 'cat <<EOF > /tmp/notes.txt\nline one\nline two\nEOF'";
  const result = formatAskPrompt(
    createBashCheck(heredoc),
    undefined,
    { command: heredoc },
    { omitBashCommand: true },
  );

  if (result.includes("cat <<EOF") || result.includes("line one")) {
    throw new Error(`Omitted prompt leaked command text: ${result}`);
  }
  if (!result.includes("requested a bash command")) {
    throw new Error(`Omitted prompt lost its phrasing: ${result}`);
  }
});

runTest("omitted bash command keeps a matched pattern hint", () => {
  const result = formatAskPrompt(
    createBashCheck("git push --force origin main", "git *"),
    "worker",
    { command: "git push --force origin main" },
    { omitBashCommand: true },
  );

  if (!result.includes("requested a bash command")) {
    throw new Error(`Omitted prompt lost its phrasing: ${result}`);
  }
  if (result.includes("git push")) {
    throw new Error(`Omitted prompt leaked command text: ${result}`);
  }
  if (!result.includes("(matched 'git *')") || !result.includes("Agent 'worker'")) {
    throw new Error(`Omitted prompt lost pattern or agent context: ${result}`);
  }
});

runTest("default prompt still shows the full command", () => {
  const command = "git status && git diff --stat";
  const result = formatAskPrompt(
    createBashCheck(command),
    undefined,
    { command },
  );

  if (!result.includes(`'${command}'`)) {
    throw new Error(`Default prompt dropped the command: ${result}`);
  }
});

runTest("non-bash tools ignore the omit flag", () => {
  const result = formatAskPrompt(
    {
      state: "ask",
      source: "tool",
      toolName: "edit",
    },
    undefined,
    { path: "src/main.ts" },
    { omitBashCommand: true },
  );

  if (!result.includes("edit")) {
    throw new Error(`Non-bash prompt lost tool name: ${result}`);
  }
});
