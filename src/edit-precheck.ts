import { readFile as fsReadFile } from "node:fs/promises";

import {
  createEditToolDefinition,
  type EditOperations,
} from "@earendil-works/pi-coding-agent";

export const EDIT_TOOL_NAME = "edit";

/**
 * Operations that let pi's own edit tool run as a pure dry run:
 * `access` is a no-op and `readFile` surfaces filesystem failures via a
 * sentinel so unreadable/missing targets fail closed (caller still prompts).
 * `writeFile` discards its input so a valid edit never mutates anything
 * during the precheck.
 */
const UNREADABLE_FILE_SENTINEL = "pi-permission-edit-precheck-unreadable-target";
const DRY_RUN_EDIT_OPERATIONS: EditOperations = {
  access: async () => {},
  readFile: async (absolutePath) => {
    try {
      return await fsReadFile(absolutePath);
    } catch {
      throw new Error(UNREADABLE_FILE_SENTINEL);
    }
  },
  writeFile: async () => {},
};

/**
 * Decide whether an `edit` tool call is guaranteed to fail validation inside
 * pi's edit tool (oldText not found / non-unique / overlapping edits / empty
 * oldText / no-op replacement / missing edits array / unreadable target).
 *
 * The dry run reuses pi's own edit implementation (`createEditToolDefinition`)
 * with no-op write operations, so the verdict always matches the pi version
 * that is actually installed. When the call would succeed the dry run simply
 * completes without writing, and the caller should prompt for permission as
 * usual.
 *
 * Returns `false` (i.e. "prompt normally") on any uncertainty so that the
 * permission prompt is never skipped for a call that could succeed.
 */
export async function isEditCallProvablyInvalid(
  input: unknown,
  cwd?: string | null,
): Promise<boolean> {
  let definition: ReturnType<typeof createEditToolDefinition>;
  try {
    definition = createEditToolDefinition(cwd ?? process.cwd(), {
      operations: DRY_RUN_EDIT_OPERATIONS,
    });
  } catch {
    // Cannot even construct the dry run tool → fail closed and prompt.
    return false;
  }

  const prepared = typeof definition.prepareArguments === "function"
    ? definition.prepareArguments(input)
    : input;

  if (prepared && typeof prepared === "object" && !Array.isArray(prepared)) {
    const edits = (prepared as { edits?: unknown }).edits;
    // pi's edit execution throws unconditionally when `edits` is missing or
    // empty ("Edit tool input is invalid. edits must contain at least one
    // replacement."), so such calls are provably invalid.
    if (!Array.isArray(edits) || edits.length === 0) {
      return true;
    }
  }

  try {
    await definition.execute(
      "permission-edit-precheck",
      prepared,
      undefined,
      () => {},
      { cwd: cwd ?? process.cwd() },
    );
    // The dry run succeeded without writing → the real call can succeed.
    return false;
  } catch (error) {
    // A filesystem failure inside the dry run (missing or unreadable target)
    // does NOT prove the call invalid: pi would reject it with a generic
    // "Could not edit file" error, but transient conditions (the file
    // appearing, permissions changing) mean we fail closed and prompt.
    if (error instanceof Error && error.message === UNREADABLE_FILE_SENTINEL) {
      return false;
    }
    // pi's own edit logic rejected the call (same read, same normalization,
    // same matching rules as the real execution).
    return true;
  }
}
