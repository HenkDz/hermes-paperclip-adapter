/**
 * Server-side adapter module exports.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel, parseModelFromConfig, resolveProvider, inferProviderFromModel } from "./detect-model.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";

import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { agentConfigurationDoc, models } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listHermesSkills as listSkills, syncHermesSkills as syncSkills } from "./skills.js";
import { detectModel } from "./detect-model.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

/**
 * Factory function that assembles the full ServerAdapterModule.
 * This is the conventional entry point used by Paperclip's plugin-loader
 * to dynamically load external adapters.
 *
 * The detectModel field uses an intersection type because the published
 * adapter-utils does not yet include it in ServerAdapterModule.
 */
export function createServerAdapter(): ServerAdapterModule & {
  detectModel?: () => Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null>;
} {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    listSkills,
    syncSkills,
    sessionCodec,
    models,
    agentConfigurationDoc,
    detectModel: () => detectModel(),
  };
}
