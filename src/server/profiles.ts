/**
 * Hermes profile management for Paperclip adapter.
 *
 * Hermes profiles are isolated instances with their own config, .env,
 * SOUL.md, sessions, memories, cron jobs, and skills. A profile lives at
 * ~/.hermes/profiles/<name>/ and is activated via `hermes -p <name>`.
 *
 * This module provides:
 *   - listProfiles(): enumerate available profiles
 *   - resolveProfilePath(): get the HERMES_HOME for a profile name
 *   - ensureProfile(): auto-create a profile if it doesn't exist (--clone)
 *   - getProfileConfig(): read a profile's model/provider from its config.yaml
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

import { HERMES_CLI, PROFILES_DIR } from "../shared/constants.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProfileInfo {
  /** Profile name (lowercase, alphanumeric) */
  name: string;
  /** Absolute path to the profile directory */
  path: string;
  /** Whether the profile has its own config.yaml */
  hasConfig: boolean;
  /** Whether the profile has its own .env */
  hasEnv: boolean;
  /** Whether the profile has a SOUL.md */
  hasSoul: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hermesHome(): string {
  return process.env.HERMES_HOME || join(homedir(), ".hermes");
}

function profilesDir(): string {
  return join(hermesHome(), PROFILES_DIR);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * List all available Hermes profiles.
 *
 * Returns "default" (the main HERMES_HOME) plus any profiles found in
 * ~/.hermes/profiles/<name>/. Profiles with invalid names or missing
 * directories are silently skipped.
 */
export async function listProfiles(): Promise<ProfileInfo[]> {
  const results: ProfileInfo[] = [];

  // Default profile (always available)
  const defaultPath = hermesHome();
  results.push({
    name: "default",
    path: defaultPath,
    hasConfig: await stat(join(defaultPath, "config.yaml")).then(() => true).catch(() => false),
    hasEnv: await stat(join(defaultPath, ".env")).then(() => true).catch(() => false),
    hasSoul: await stat(join(defaultPath, "SOUL.md")).then(() => true).catch(() => false),
  });

  // Named profiles
  const profilesPath = profilesDir();
  try {
    const entries = await readdir(profilesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip dotfiles and names with spaces/special chars
      if (!/^[a-z0-9_-]+$/.test(entry.name)) continue;

      const profilePath = join(profilesPath, entry.name);
      results.push({
        name: entry.name,
        path: profilePath,
        hasConfig: await stat(join(profilePath, "config.yaml")).then(() => true).catch(() => false),
        hasEnv: await stat(join(profilePath, ".env")).then(() => true).catch(() => false),
        hasSoul: await stat(join(profilePath, "SOUL.md")).then(() => true).catch(() => false),
      });
    }
  } catch {
    // profiles/ directory doesn't exist — no named profiles
  }

  return results;
}

/**
 * Resolve the absolute path for a named profile.
 *
 * "default" resolves to HERMES_HOME itself.
 * Any other name resolves to HERMES_HOME/profiles/<name>/.
 *
 * Returns null if the profile name is invalid.
 */
export function resolveProfilePath(name: string): string | null {
  if (name === "default" || !name) {
    return hermesHome();
  }
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return null;
  }
  return join(profilesDir(), name);
}

/**
 * Ensure a profile exists, creating it if necessary.
 *
 * If the profile doesn't exist, runs `hermes profile create <name> --clone --no-alias`
 * to create it from the active profile (inherits config, .env, SOUL.md, skills).
 *
 * This is safe to call on every run — it's a no-op if the profile already exists.
 *
 * Returns the absolute path to the profile directory.
 */
export async function ensureProfile(name: string): Promise<string | null> {
  const path = resolveProfilePath(name);
  if (!path) return null;

  // Check if profile already exists
  try {
    const s = await stat(path);
    if (s.isDirectory()) return path;
  } catch {
    // Doesn't exist — create it
  }

  // Can't create "default" — it always exists
  if (name === "default" || !name) return hermesHome();

  try {
    // hermes profile create <name> --clone --no-alias
    execSync(`${HERMES_CLI} profile create ${name} --clone --no-alias`, {
      stdio: "pipe",
      timeout: 30000,
      env: { ...process.env },
    });
    return path;
  } catch (err) {
    // Profile creation failed — log but don't block execution.
    // The adapter will fall back to the default profile.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[hermes-adapter] Failed to create profile "${name}": ${msg}`);
    return null;
  }
}

/**
 * Get the config.yaml content for a specific profile.
 *
 * For the "default" profile, reads HERMES_HOME/config.yaml.
 * For named profiles, reads HERMES_HOME/profiles/<name>/config.yaml.
 * Falls back to HERMES_HOME/config.yaml if the profile doesn't have its own.
 */
export async function getProfileConfigContent(name: string): Promise<string | null> {
  const profilePath = resolveProfilePath(name);
  if (!profilePath) return null;

  // Try profile-specific config first
  try {
    return await readFile(join(profilePath, "config.yaml"), "utf-8");
  } catch {
    // Fall back to default config
  }

  // Fall back to HERMES_HOME/config.yaml
  if (name !== "default") {
    try {
      return await readFile(join(hermesHome(), "config.yaml"), "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}
