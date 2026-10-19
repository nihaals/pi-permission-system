// ---------------------------------------------------------------------------
// Red tests: invalid `edit` tool calls must not trigger permission prompts.
//
// pi validates edit arguments (oldText exact/fuzzy match, uniqueness,
// disjointness) only at execution time, while the permission system prompts
// for `ask` tool calls before execution. An edit call that pi is guaranteed
// to reject therefore used to show a permission dialog for a doomed call.
//
// The fix: pre-validate edit calls with pi's own edit implementation running
// as a dry run (no-op writeFile). Provably invalid calls skip the prompt and
// fall through to pi, which returns its normal validation error.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
} from "../src/extension-config.js";
import { isEditCallProvablyInvalid } from "../src/edit-precheck.js";
import piPermissionSystemExtension from "../src/index.js";
import { runAsyncTest, runTest } from "./test-harness.js";

const SUBAGENT_ENV_KEYS = [
  "PI_IS_SUBAGENT",
  "PI_SUBAGENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT",
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
  "PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR",
] as const;

for (const key of SUBAGENT_ENV_KEYS) {
  delete process.env[key];
}

// ---------------------------------------------------------------------------
// Unit tests: isEditCallProvablyInvalid (dry run through pi's own edit logic)
// ---------------------------------------------------------------------------

function createTempFileSetup(): { rootDir: string; filePath: string; cleanup: () => void } {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-permission-edit-precheck-"));
  const filePath = join(rootDir, "sample.ts");
  writeFileSync(
    filePath,
    [
      "export const alpha = 1;",
      "export const beta = 2;",
      "export const gamma = 3;",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    rootDir,
    filePath,
    cleanup: (): void => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

await runAsyncTest("edit call with oldText that does not exist is provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [{ oldText: "const TOTALLY_ABSENT_SYMBOL = false;", newText: "const x = 1;" }],
    });
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("edit call with non-unique oldText is provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [{ oldText: "export const", newText: "export const delta" }],
    });
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("edit call with overlapping edits is provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [
        { oldText: "export const alpha = 1;\nexport const beta = 2;", newText: "x" },
        { oldText: "export const beta = 2;\nexport const gamma = 3;", newText: "y" },
      ],
    });
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("edit call with empty oldText is provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [{ oldText: "", newText: "x" }],
    });
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("no-op edit (oldText === newText) is provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [{ oldText: "export const alpha = 1;", newText: "export const alpha = 1;" }],
    });
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("edit call without an edits array is provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({ path: setup.filePath });
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("edit call targeting a missing file is NOT treated as provably invalid (fail closed)", async () => {
  const setup = createTempFileSetup();
  try {
    // pi would reject this with "Could not edit file", but missing/unreadable
    // targets are transient conditions, so the permission prompt is kept.
    const invalid = await isEditCallProvablyInvalid({
      path: join(setup.rootDir, "does-not-exist.ts"),
      edits: [{ oldText: "a", newText: "b" }],
    });
    assert.equal(invalid, false);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("valid edit call is not considered provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [{ oldText: "export const alpha = 1;", newText: "export const alpha = 42;" }],
    });
    assert.equal(invalid, false);
    assert.ok(existsSync(setup.filePath));
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("valid multi-edit call is not considered provably invalid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [
        { oldText: "export const alpha = 1;", newText: "export const alpha = 10;" },
        { oldText: "export const gamma = 3;", newText: "export const gamma = 30;" },
      ],
    });
    assert.equal(invalid, false);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("fuzzy-matching whitespace differences still count as valid", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid({
      path: setup.filePath,
      edits: [{ oldText: "export const alpha = 1; ", newText: "export const alpha = 42;" }],
    });
    assert.equal(invalid, false);
  } finally {
    setup.cleanup();
  }
});

await runAsyncTest("relative paths resolve against cwd", async () => {
  const setup = createTempFileSetup();
  try {
    const invalid = await isEditCallProvablyInvalid(
      {
        path: "sample.ts",
        edits: [{ oldText: "const TOTALLY_ABSENT_SYMBOL = false;", newText: "const x = 1;" }],
      },
      setup.rootDir,
    );
    assert.equal(invalid, true);
  } finally {
    setup.cleanup();
  }
});

// ---------------------------------------------------------------------------
// End-to-end: tool_call handler must not prompt for provably invalid edits
// ---------------------------------------------------------------------------

type MockHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

interface PrecheckHarness {
  baseDir: string;
  cwd: string;
  handlers: Record<string, MockHandler>;
  prompts: string[];
  cleanup: () => Promise<void>;
}

function createEditAskHarness(cwd: string): PrecheckHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-edit-ask-"));
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalLogsDir = process.env[LOGS_DIR_ENV_KEY];

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(baseDir, "pi-permissions.jsonc"),
    `${JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      ...DEFAULT_EXTENSION_CONFIG,
    }, null, 2)}\n`,
    "utf8",
  );

  process.env.PI_CODING_AGENT_DIR = baseDir;
  process.env[LOGS_DIR_ENV_KEY] = join(baseDir, "extension-logs");
  try {
    piPermissionSystemExtension({
      on: (name: string, handler: MockHandler): void => {
        handlers[name] = handler;
      },
      registerCommand: (): void => {},
      getAllTools: (): Array<{ name: string }> => [{ name: "edit" }, { name: "read" }],
      setActiveTools: (): void => {},
      events: {
        emit: (): void => {},
      },
    } as never);
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }

  const makeContext = (): Record<string, unknown> => ({
    cwd,
    hasUI: true,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "test-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      select: async (title: string): Promise<string | undefined> => {
        prompts.push(title);
        return "Allow once";
      },
      input: async (): Promise<string | undefined> => undefined,
      notify: (): void => {},
      setStatus: (): void => {},
    },
  });

  return {
    baseDir,
    cwd,
    handlers,
    prompts,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, makeContext()));
      if (originalLogsDir === undefined) {
        delete process.env[LOGS_DIR_ENV_KEY];
      } else {
        process.env[LOGS_DIR_ENV_KEY] = originalLogsDir;
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

await runAsyncTest("invalid edit under ask policy returns success result without prompting", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-permission-edit-e2e-"));
  const cwd = join(rootDir, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "sample.ts"), "export const alpha = 1;\n", "utf8");

  const harness = createEditAskHarness(cwd);
  try {
    const handler = harness.handlers.tool_call;
    assert.equal(typeof handler, "function");
    const result = (await handler(
      {
        toolName: "edit",
        toolCallId: "edit-invalid-1",
        input: {
          path: join(cwd, "sample.ts"),
          edits: [{ oldText: "const TOTALLY_ABSENT_SYMBOL = false;", newText: "const x = 1;" }],
        },
      },
      {
        cwd,
        hasUI: true,
        sessionManager: {
          getEntries: (): unknown[] => [],
          getSessionId: (): string => "test-session",
          getSessionDir: (): string => cwd,
        },
        ui: {
          select: async (title: string): Promise<string | undefined> => {
            harness.prompts.push(title);
            return "Allow once";
          },
          input: async (): Promise<string | undefined> => undefined,
          notify: (): void => {},
          setStatus: (): void => {},
        },
      } as never,
    )) as Record<string, unknown>;

    // Not blocked by the permission system — pi executes the tool and returns
    // its own validation error without any permission dialog.
    assert.deepEqual(result, {});
    assert.deepEqual(harness.prompts, []);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

await runAsyncTest("valid edit under ask policy still prompts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-permission-edit-e2e-valid-"));
  const cwd = join(rootDir, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "sample.ts"), "export const alpha = 1;\n", "utf8");

  const harness = createEditAskHarness(cwd);
  try {
    const handler = harness.handlers.tool_call;
    assert.equal(typeof handler, "function");
    const result = (await handler(
      {
        toolName: "edit",
        toolCallId: "edit-valid-1",
        input: {
          path: join(cwd, "sample.ts"),
          edits: [{ oldText: "export const alpha = 1;", newText: "export const alpha = 42;" }],
        },
      },
      {
        cwd,
        hasUI: true,
        sessionManager: {
          getEntries: (): unknown[] => [],
          getSessionId: (): string => "test-session",
          getSessionDir: (): string => cwd,
        },
        ui: {
          select: async (title: string): Promise<string | undefined> => {
            harness.prompts.push(title);
            return "Allow once";
          },
          input: async (): Promise<string | undefined> => undefined,
          notify: (): void => {},
          setStatus: (): void => {},
        },
      } as never,
    )) as Record<string, unknown>;

    assert.deepEqual(result, {});
    assert.equal(harness.prompts.length, 1);
    assert.match(String(harness.prompts[0]), /Permission Required/);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

runTest("dry run edit operations never expose a writeFile that persists", () => {
  // Sanity: the module must construct its dry-run tool with a no-op writer so
  // a "valid" verdict can never mutate the target file.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "edit-precheck.ts"),
    "utf8",
  );
  assert.match(source, /writeFile: async \(\) => \{\}/);
});

console.log("All edit-precheck tests passed.");
