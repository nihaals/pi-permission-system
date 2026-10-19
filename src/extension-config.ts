import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyEdits, modify, parseTree, type ParseError as JsoncParseError } from "jsonc-parser";

import { toRecord } from "./common.js";
import { formatJsoncConfigLoadWarning, isNodeErrorWithCode, parseJsoncConfig } from "./jsonc-config.js";
import { normalizePermissionEscapeAction, type PermissionEscapeAction } from "./permission-dialog.js";

export const EXTENSION_ID = "pi-permission-system";

/**
 * Extension settings. These live as optional top-level keys of the global policy
 * file (`pi-permissions.jsonc`) alongside the permission sections; see the JSON
 * schema for the documented shape and defaults.
 */
export interface PermissionSystemExtensionConfig {
  /** Master switch. When false, the extension skips all registrations and startup work. Hand-edit only. */
  enabled?: boolean;
  debug: boolean;
  yoloMode: boolean;
  forwardedPromptTimeoutSeconds: number | null;
  /** Behavior when `esc` is pressed at a permission prompt. Defaults to `reject`. */
  escapeAction?: PermissionEscapeAction;
}

export interface PermissionSystemConfigLoadResult {
  config: PermissionSystemExtensionConfig;
  warning?: string;
}

export interface PermissionSystemConfigSaveResult {
  success: boolean;
  error?: string;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  enabled: true,
  debug: false,
  yoloMode: false,
  forwardedPromptTimeoutSeconds: 30,
  escapeAction: "reject",
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const LOGS_DIR = join(EXTENSION_ROOT, "logs");
export const POLICY_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR";
export const LOGS_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_LOGS_DIR";

/** Root directory holding the global policy file and per-agent permission overrides. */
export function getPolicyAgentDir(): string {
  const override = process.env[POLICY_AGENT_DIR_ENV_KEY]?.trim();
  return override ? resolve(override) : getAgentDir();
}

/** Global policy file: permission sections plus extension settings. */
export function getPolicyFilePath(): string {
  return join(getPolicyAgentDir(), "pi-permissions.jsonc");
}

export function getPermissionSystemLogsDir(logsDir?: string): string {
  const overridePath = process.env[LOGS_DIR_ENV_KEY]?.trim();
  return logsDir || overridePath || LOGS_DIR;
}

export function getPermissionSystemDebugPath(logsDir = getPermissionSystemLogsDir()): string {
  return join(logsDir, `${EXTENSION_ID}-debug.jsonl`);
}

export function cloneDefaultConfig(): PermissionSystemExtensionConfig {
  return {
    enabled: DEFAULT_EXTENSION_CONFIG.enabled,
    debug: DEFAULT_EXTENSION_CONFIG.debug,
    yoloMode: DEFAULT_EXTENSION_CONFIG.yoloMode,
    forwardedPromptTimeoutSeconds: DEFAULT_EXTENSION_CONFIG.forwardedPromptTimeoutSeconds,
    escapeAction: DEFAULT_EXTENSION_CONFIG.escapeAction,
  };
}

export function normalizePermissionSystemConfig(raw: unknown): PermissionSystemExtensionConfig {
  const record = toRecord(raw);
  const rawTimeout = record.forwardedPromptTimeoutSeconds;
  let forwardedPromptTimeoutSeconds: number | null = DEFAULT_EXTENSION_CONFIG.forwardedPromptTimeoutSeconds;

  if (rawTimeout === null || rawTimeout === false) {
    forwardedPromptTimeoutSeconds = null;
  } else if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
    forwardedPromptTimeoutSeconds = rawTimeout;
  }

  return {
    enabled: record.enabled !== false,
    debug: record.debug === true,
    yoloMode: record.yoloMode === true,
    forwardedPromptTimeoutSeconds,
    escapeAction: normalizePermissionEscapeAction(record.escapeAction),
  };
}

/**
 * Loads extension settings from the global policy file. A missing file is not an
 * error: defaults are used and nothing is written to disk.
 */
export function loadPermissionSystemConfig(policyPath = getPolicyFilePath()): PermissionSystemConfigLoadResult {
  let raw: string;
  try {
    raw = readFileSync(policyPath, "utf-8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { config: cloneDefaultConfig() };
    }
    return {
      config: cloneDefaultConfig(),
      warning: `Failed to read permission-system settings from '${policyPath}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    // Strip a UTF-8 BOM if present so the JSONC parser can handle it.
    const bomStripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = parseJsoncConfig(bomStripped, policyPath, "permission policy file");
    return { config: normalizePermissionSystemConfig(parsed) };
  } catch (error) {
    return {
      config: cloneDefaultConfig(),
      warning: formatJsoncConfigLoadWarning(policyPath, error, "permission policy file", "using default extension settings")
        ?? undefined,
    };
  }
}

/** Extension-managed keys. `enabled` is intentionally excluded: it is hand-edit only. */
const MANAGED_SETTINGS_KEYS = ["debug", "yoloMode", "forwardedPromptTimeoutSeconds", "escapeAction"] as const;

function formatSaveValue(key: (typeof MANAGED_SETTINGS_KEYS)[number], config: PermissionSystemExtensionConfig): unknown {
  switch (key) {
    case "debug":
      return config.debug;
    case "yoloMode":
      return config.yoloMode;
    case "forwardedPromptTimeoutSeconds":
      return config.forwardedPromptTimeoutSeconds;
    case "escapeAction":
      return config.escapeAction ?? DEFAULT_EXTENSION_CONFIG.escapeAction;
  }
}

/**
 * Resolves the actual write target. If configPath is a symlink, returns the
 * realpath so that the symlink relationship is preserved (we write through to
 * the target instead of replacing the symlink with a regular file).
 */
function resolveWriteTarget(configPath: string): { writePath: string; isSymlink: boolean } {
  try {
    const stats = lstatSync(configPath);
    if (stats.isSymbolicLink()) {
      const realPath = realpathSync(configPath);
      return { writePath: realPath, isSymlink: true };
    }
  } catch (error) {
    // A missing file is expected (first write); any other lstat/realpath failure
    // falls through to writing configPath directly as a safe default.
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      return { writePath: configPath, isSymlink: false };
    }
  }
  return { writePath: configPath, isSymlink: false };
}

/**
 * Detects duplicate root-level occurrences of any managed settings key. JSONC
 * last-wins parsing makes such files ambiguous for textual edits (which can only
 * update one occurrence), so they need the re-serialization fallback.
 */
function hasDuplicateManagedKeys(tree: NonNullable<ReturnType<typeof parseTree>>): boolean {
  const seen = new Set<string>();
  for (const property of tree.children ?? []) {
    const keyNode = (property.children ?? [])[0];
    const name = typeof keyNode?.value === "string" ? keyNode.value : "";
    if (MANAGED_SETTINGS_KEYS.includes(name as (typeof MANAGED_SETTINGS_KEYS)[number])) {
      if (seen.has(name)) {
        return true;
      }
      seen.add(name);
    }
  }
  return false;
}

/**
 * Saves extension settings into the global policy file using JSONC tree edits so
 * that comments, formatting, and all other keys (permissions, custom keys) are
 * preserved verbatim.
 *
 * - If the file does not exist, it is created with the managed settings only.
 * - If the file cannot be parsed, saving is refused so existing permission data
 *   is never destroyed.
 * - Files with duplicate settings keys (last-wins in JSONC) cannot be edited
 *   textually; they fall back to a clean re-serialization of the parsed record.
 */
export function savePermissionSystemConfig(
  config: PermissionSystemExtensionConfig,
  policyPath = getPolicyFilePath(),
): PermissionSystemConfigSaveResult {
  const normalized = normalizePermissionSystemConfig(config);

  let text: string;
  if (existsSync(policyPath)) {
    try {
      text = readFileSync(policyPath, "utf-8");
    } catch (error) {
      return {
        success: false,
        error: `Failed to read permission policy file at '${policyPath}': ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Strip a UTF-8 BOM if present so the JSONC parser can handle the content.
    text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } else {
    text = `${JSON.stringify(
      Object.fromEntries(MANAGED_SETTINGS_KEYS.map((key) => [key, formatSaveValue(key, normalized)])),
      null,
      2,
    )}\n`;
  }

  // Apply one key at a time, re-parsing between keys so insertion offsets are
  // always computed against the current document (comments are untouched).
  for (const key of MANAGED_SETTINGS_KEYS) {
    const parseErrors: JsoncParseError[] = [];
    const tree = parseTree(text, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0 || !tree || tree.type !== "object") {
      return {
        success: false,
        error: `Refusing to save permission-system settings at '${policyPath}': the existing file is corrupt or unparseable. Manual intervention is required to preserve existing permission data.`,
      };
    }

    if (hasDuplicateManagedKeys(tree)) {
      // Pathological last-wins file: textual edits cannot reliably target the
      // effective value. Fall back to re-serializing the parsed record.
      const parsed = parseJsoncConfig(text, policyPath, "permission policy file") as Record<string, unknown>;
      for (const managedKey of MANAGED_SETTINGS_KEYS) {
        parsed[managedKey] = formatSaveValue(managedKey, normalized);
      }
      text = `${JSON.stringify(parsed, null, 2)}\n`;
      break;
    }

    const edits = modify(text, [key], formatSaveValue(key, normalized), {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    text = applyEdits(text, edits);
  }

  const { writePath } = resolveWriteTarget(policyPath);
  const tmpPath = `${writePath}.tmp`;

  try {
    writeFileSync(tmpPath, text, "utf-8");
    renameSync(tmpPath, writePath);
    return { success: true };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch (cleanupError) {
      // Temp-file cleanup is best-effort; the OS will reclaim orphaned temp
      // files. Surface non-ENOENT failures so they are not silently lost.
      if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
        // Intentionally not propagated: the primary save error below is more
        // actionable to the caller than a leftover temp-file cleanup failure.
        void cleanupError;
      }
    }

    return {
      success: false,
      error: `Failed to save permission-system settings at '${policyPath}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function ensurePermissionSystemLogsDirectory(logsDir = getPermissionSystemLogsDir()): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
