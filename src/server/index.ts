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
export {
  listProfiles,
  resolveProfilePath,
  ensureProfile,
  getProfileConfigContent,
} from "./profiles.js";

import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/** Matches Paperclip's AdapterConfigSchema (not yet in all published adapter-utils). */
interface AdapterConfigSchema {
  fields: Array<{
    key: string;
    label: string;
    type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
    options?: Array<{ label: string; value: string; group?: string }>;
    default?: unknown;
    hint?: string;
    required?: boolean;
    group?: string;
    meta?: Record<string, unknown>;
  }>;
}
import {
  ADAPTER_TYPE,
  VALID_DELIVERY_TARGETS,
  DEFAULT_DELIVERY_TARGET,
  VALID_MEMORY_SCOPES,
  DEFAULT_MEMORY_SCOPE,
} from "../shared/constants.js";
import { agentConfigurationDoc, models } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listHermesSkills as listSkills, syncHermesSkills as syncSkills } from "./skills.js";
import { detectModel } from "./detect-model.js";
import { listProfiles } from "./profiles.js";

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
 * detectModel and getConfigSchema use an intersection type when the
 * installed @paperclipai/adapter-utils types lag behind the fork.
 */
export function createServerAdapter(): ServerAdapterModule & {
  detectModel?: () => Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null>;
  getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;
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

    async getConfigSchema(): Promise<AdapterConfigSchema> {
      const profiles = await listProfiles();

      return {
        fields: [
          {
            key: "profile",
            label: "Hermes Profile",
            type: "select",
            options: profiles.map((p) => ({ label: p.name, value: p.name })),
            default: "default",
            hint: "Isolated Hermes profile with its own config, memories, and skills.",
          },
          {
            key: "memoryScope",
            label: "Memory Scope",
            type: "select",
            options: VALID_MEMORY_SCOPES.map((v) => ({
              label: v.charAt(0).toUpperCase() + v.slice(1),
              value: v,
            })),
            default: DEFAULT_MEMORY_SCOPE,
            hint: "Session = resume within agent, Persistent = survive agent recreation, Ephemeral = fresh every run.",
          },
          {
            key: "deliveryTarget",
            label: "Delivery Target",
            type: "select",
            options: VALID_DELIVERY_TARGETS.map((v) => ({
              label: v === "none" ? "None" : v.charAt(0).toUpperCase() + v.slice(1),
              value: v,
            })),
            default: DEFAULT_DELIVERY_TARGET,
            hint: "Where to send run summaries besides the Paperclip UI.",
          },
        ],
      };
    },
  };
}
