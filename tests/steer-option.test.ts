import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piPermissionSystemExtension from "../src/index.js";
import { DEFAULT_EXTENSION_CONFIG, LOGS_DIR_ENV_KEY } from "../src/extension-config.js";
import {
  isPermissionEscapeAction,
  normalizePermissionEscapeAction,
  requestPermissionDecisionFromUi,
  type PermissionDecisionUi,
  type PermissionPromptDecision,
} from "../src/permission-dialog.js";
import { formatUserSteerReason } from "../src/permission-prompts.js";
import { runAsyncTest } from "./test-harness.js";

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type SteerToolCallHarness = {
  baseDir: string;
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
  cleanup: () => Promise<void>;
};

type SteerMockContextOptions = {
  selectResponse?: string | undefined;
  inputResponse?: string | undefined;
  selectOptionsCollector?: Array<string[]>;
  abortCalls?: number[];
};

const POLICY_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR";
const SUBAGENT_ENV_KEYS = [
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT_ID",
  "PI_AGENT_ROUTER_AGENT_NAME",
  "PI_AGENT_ROUTER_DELEGATION_ID",
  "PI_AGENT_SUBAGENT_PARENT_SESSION_ID",
] as const;

function createSteerUi(options: {
  selectResponse?: string | undefined;
  inputResponse?: string | undefined;
  selectOptionsCollector?: Array<string[]>;
}): PermissionDecisionUi {
  return {
    async select(_title: string, selectOptions: string[]): Promise<string | undefined> {
      options.selectOptionsCollector?.push(selectOptions);
      return options.selectResponse;
    },
    async input(): Promise<string | undefined> {
      return options.inputResponse;
    },
  };
}

function createSteerMockContext(
  cwd: string,
  prompts: string[],
  options: SteerMockContextOptions = {},
): Record<string, unknown> {
  const abortCalls = options.abortCalls ?? [];
  return {
    cwd,
    hasUI: true,
    abort: (): void => {
      abortCalls.push(1);
    },
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "steer-test-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string, selectOptions?: Array<string | { label: string }>): Promise<string | undefined> => {
        prompts.push(title);
        const labels = (selectOptions ?? []).map((option) => typeof option === "string" ? option : option.label);
        options.selectOptionsCollector?.push(labels);
        return options.selectResponse;
      },
      input: async (): Promise<string | undefined> => options.inputResponse,
    },
  };
}

function createSteerToolCallHarness(): SteerToolCallHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-steer-"));
  const cwd = join(baseDir, "repo");
  const policyDir = join(baseDir, "policy");
  const logsDir = join(baseDir, "logs");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};

  const originalValues = new Map<string, string | undefined>();
  for (const key of ["PI_CODING_AGENT_DIR", POLICY_AGENT_DIR_ENV_KEY, LOGS_DIR_ENV_KEY, ...SUBAGENT_ENV_KEYS]) {
    originalValues.set(key, process.env[key]);
  }

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(policyDir, "agents"), { recursive: true });
  writeFileSync(
    join(policyDir, "pi-permissions.jsonc"),
    `${JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      ...DEFAULT_EXTENSION_CONFIG,
    }, null, 2)}\n`,
    "utf8",
  );

  process.env.PI_CODING_AGENT_DIR = policyDir;
  process.env[POLICY_AGENT_DIR_ENV_KEY] = policyDir;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;
  for (const key of SUBAGENT_ENV_KEYS) {
    delete process.env[key];
  }

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: (): Array<{ name: string }> => [{ name: "read" }],
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: {
      emit: (): void => {},
    },
  } as never);

  return {
    baseDir,
    cwd,
    prompts,
    handlers,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createSteerMockContext(cwd, prompts)));
      for (const [key, value] of originalValues.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

async function runToolCall(
  harness: SteerToolCallHarness,
  event: Record<string, unknown>,
  contextOptions: SteerMockContextOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function", "tool_call handler should be registered");
  const result = await Promise.resolve(
    handler(event, createSteerMockContext(harness.cwd, harness.prompts, contextOptions)),
  );
  return (result ?? {}) as Record<string, unknown>;
}

async function decide(
  ui: PermissionDecisionUi,
  options?: Parameters<typeof requestPermissionDecisionFromUi>[3],
): Promise<PermissionPromptDecision> {
  return requestPermissionDecisionFromUi(ui, "Permission Required", "Agent requested tool 'read'. Allow this call?", options);
}

await runAsyncTest("dialog: Stop and steer with a message returns a steer decision carrying the note", async () => {
  const decision = await decide(
    createSteerUi({ selectResponse: "Stop and steer", inputResponse: "use rg instead of find" }),
  );
  assert.equal(decision.approved, false);
  assert.equal(decision.state, "steer");
  assert.equal(decision.steerMessage, "use rg instead of find");
  assert.equal(decision.denialReason, undefined);
});

await runAsyncTest("dialog: Stop and steer with an empty note returns a steer decision without a message", async () => {
  const decision = await decide(
    createSteerUi({ selectResponse: "Stop and steer", inputResponse: "   " }),
  );
  assert.equal(decision.approved, false);
  assert.equal(decision.state, "steer");
  assert.equal(decision.steerMessage, undefined);
});

await runAsyncTest("dialog: escapeAction steer prompts for guidance when the select is dismissed", async () => {
  const decision = await decide(
    createSteerUi({ selectResponse: undefined, inputResponse: "check the changelog first" }),
    { escapeAction: "stop_and_steer" },
  );
  assert.equal(decision.state, "steer");
  assert.equal(decision.steerMessage, "check the changelog first");
});

await runAsyncTest("dialog: escapeAction reject still rejects on dismissal", async () => {
  const decision = await decide(
    createSteerUi({ selectResponse: undefined }),
    { escapeAction: "reject" },
  );
  assert.equal(decision.state, "reject");
});

await runAsyncTest("dialog: select options include the Stop and steer button", async () => {
  const selectOptions: Array<string[]> = [];
  await decide(
    createSteerUi({ selectResponse: "Reject", selectOptionsCollector: selectOptions }),
  );
  assert.equal(selectOptions.length, 1);
  assert.ok(selectOptions[0]?.includes("Stop and steer"), `expected Stop and steer in options, got ${JSON.stringify(selectOptions[0])}`);
});

await runAsyncTest("escape action helpers accept steer and normalize invalid values to reject", async () => {
  assert.equal(isPermissionEscapeAction("stop_and_steer"), true);
  assert.equal(isPermissionEscapeAction("reject"), true);
  assert.equal(isPermissionEscapeAction("reject_with_reason"), true);
  assert.equal(isPermissionEscapeAction("bogus"), false);
  assert.equal(normalizePermissionEscapeAction("stop_and_steer"), "stop_and_steer");
  assert.equal(normalizePermissionEscapeAction(undefined), "reject");
  assert.equal(normalizePermissionEscapeAction("nonsense"), "reject");
});

await runAsyncTest("formatUserSteerReason: steering note wording is soft and never hard-stops", async () => {
  const withNote = formatUserSteerReason(
    { toolName: "read", source: "tool", state: "ask" },
    "use rg instead",
  );
  assert.match(withNote, /not a rejection/);
  assert.match(withNote, /Steering note: use rg instead/);
  assert.equal(withNote.includes("Hard stop"), false);
  assert.equal(withNote.includes("Do not retry"), false);

  const withoutNote = formatUserSteerReason(
    { toolName: "bash", source: "bash", state: "ask", command: "ls -la" },
    undefined,
  );
  assert.match(withoutNote, /not a rejection/);
  assert.match(withoutNote, /The user will follow up/);
  assert.equal(withoutNote.includes("Hard stop"), false);
});

await runAsyncTest("extension: steered tool call is blocked with soft wording and no hard stop", async () => {
  const harness = createSteerToolCallHarness();
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "test" }, createSteerMockContext(harness.cwd, harness.prompts)));

    const abortCalls: number[] = [];
    const result = await runToolCall(
      harness,
      { toolName: "read", toolCallId: "steer-e2e-1", input: { path: "src/a.ts" } },
      { selectResponse: "Stop and steer", inputResponse: "use rg instead", abortCalls },
    );

    assert.equal(result.block, true);
    const reason = typeof result.reason === "string" ? result.reason : "";
    assert.match(reason, /not a rejection/);
    assert.match(reason, /Steering note: use rg instead/);
    assert.match(reason, /tool 'read'/);
    assert.equal(reason.includes("Hard stop"), false);
    assert.equal(abortCalls.length, 0, "steer with a note must not abort the run");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("extension: empty steer pauses via ctx.abort and blocks with follow-up wording", async () => {
  const harness = createSteerToolCallHarness();
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "test" }, createSteerMockContext(harness.cwd, harness.prompts)));

    const abortCalls: number[] = [];
    const result = await runToolCall(
      harness,
      { toolName: "read", toolCallId: "steer-e2e-2", input: { path: "src/a.ts" } },
      { selectResponse: "Stop and steer", inputResponse: "", abortCalls },
    );

    assert.equal(result.block, true);
    const reason = typeof result.reason === "string" ? result.reason : "";
    assert.match(reason, /not a rejection/);
    assert.match(reason, /The user will follow up/);
    assert.equal(reason.includes("Hard stop"), false);
    assert.equal(abortCalls.length, 1, "empty steer must pause the run via ctx.abort");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("extension: a steered decision is not cached for identical retry prompts", async () => {
  const harness = createSteerToolCallHarness();
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "test" }, createSteerMockContext(harness.cwd, harness.prompts)));

    const event = { toolName: "read", toolCallId: "steer-e2e-3", input: { path: "src/a.ts" } };
    const first = await runToolCall(harness, event, { selectResponse: "Stop and steer", inputResponse: "read the changelog first" });
    const second = await runToolCall(harness, event, { selectResponse: "Allow once" });

    assert.equal(first.block, true);
    assert.equal(second.block, undefined, "retried identical call must re-prompt and allow instead of reusing the steer");
    assert.equal(harness.prompts.length, 2, "steer decisions must not be reused from the duplicate-prompt cache");
  } finally {
    await harness.cleanup();
  }
});
