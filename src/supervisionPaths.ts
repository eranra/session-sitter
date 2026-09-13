/**
 * Where supervision writes, and which of those destinations the user has to configure.
 *
 * Two very different things used to share one setting. `sessionSitter.supervisorStateDir` gated
 * BOTH the AI supervisor (which shells out to a classifier CLI, so it must stay opt-in) AND the
 * reporting of decisions (a record under `records/`, the panel's activity feed, the human
 * channel). That made every DETERMINISTIC `sessionSitter.autoRespond` decision invisible on a
 * default install: the rules fire without any supervisor, but with no state dir there was nowhere
 * to write the record, so nothing reached the panel or Telegram.
 *
 * Splitting them keeps both properties:
 *  - `dir` always resolves (falling back to the extension's own global storage), so a rule
 *    decision is ALWAYS recorded and always shows up in the activity feed.
 *  - `explicit` stays false until the user sets the setting, and the AI supervisor stays gated on
 *    that — defaulting the path must never start a classifier nobody asked for.
 *
 * ## Resolving includes creating, because a path that cannot be created is not an answer
 *
 * A configured dir used to be taken at its word. It reached `ensureDirs`, whose `mkdir` threw
 * straight out of `activate()`, and one unwritable path — a Linux `supervisorStateDir` opened on
 * macOS, a stale mount, a directory removed since it was configured — took the entire extension
 * down: no panel, no supervision, no Telegram. The only trace was VS Code's own exthost log,
 * because the file log this extension writes lives *inside* the directory that could not be made.
 *
 * So resolution now ends at a directory that exists. A configured dir that cannot be created is
 * reported in `unusable` and abandoned for the default, which behaves exactly as an unset setting
 * does — including leaving the AI supervisor off, since a directory we could not create is not one
 * the user chose.
 */

import * as path from 'path';

/** Create a directory and its parents. Throws when it cannot — that is the signal this uses. */
export type EnsureDir = (dir: string) => void;

export interface ResolvedStateDir {
  /** The directory supervision state is written to. Always non-empty, and already created. */
  dir: string;
  /** True only when the user set `sessionSitter.supervisorStateDir` themselves AND it was usable. */
  explicit: boolean;
  /**
   * The configured directory that had to be abandoned, and why.
   *
   * Set only when the user configured a directory that could not be created. It exists so the
   * caller can say so in the log: falling back silently would leave the user's records in a place
   * they did not choose and cannot find, which is how a misconfiguration becomes a bug report.
   */
  unusable?: { configured: string; reason: string };
}

/**
 * Resolve the supervision state dir: the configured setting when it can be created, else
 * `<globalStorage>/state`.
 *
 * `globalStorage` is the extension's own per-install directory, so the fallback is always writable
 * and never collides with another extension.
 *
 * `ensure` is a parameter rather than a direct `fs` call so this stays a decision about paths that
 * a test can drive both ways without touching the developer's own disk.
 */
export function resolveStateDir(
  configured: string | undefined, globalStorage: string, ensure: EnsureDir,
): ResolvedStateDir {
  const fallback = path.join(globalStorage, 'state');
  const trimmed = (configured ?? '').trim();
  if (trimmed) {
    try {
      ensure(trimmed);
      return { dir: trimmed, explicit: true };
    } catch (e) {
      return {
        dir: ensureBestEffort(fallback, ensure),
        explicit: false,
        unusable: { configured: trimmed, reason: reasonFrom(e) },
      };
    }
  }
  return { dir: ensureBestEffort(fallback, ensure), explicit: false };
}

/**
 * Return the fallback whether or not it could be created.
 *
 * There is nothing left to fall back to, and throwing would take the extension down over something
 * no user can act on. A later write recreates what it needs, or fails alone.
 */
function ensureBestEffort(dir: string, ensure: EnsureDir): string {
  try { ensure(dir); } catch { /* best-effort */ }
  return dir;
}

function reasonFrom(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The repo the supervisor reasons about: an explicit `supervisorRepoPath`, else the parent of an
 * EXPLICIT state dir (the `<repo>/.state` and `<repo>/supervisor/.state` convention), else the
 * first workspace folder.
 *
 * A defaulted state dir is deliberately not used here — its parent is the extension's global
 * storage, which is not a repo, and pointing the supervisor at it would be worse than having no
 * root at all. A state dir that could not be created is defaulted for exactly this purpose too: it
 * is not `explicit`, so its parent is never mistaken for a repo either.
 */
export function resolveWorkspaceRoot(
  configuredRepoPath: string | undefined,
  stateDir: ResolvedStateDir,
  firstWorkspaceFolder: string | undefined,
): string {
  const repo = (configuredRepoPath ?? '').trim();
  if (repo) { return repo; }
  if (stateDir.explicit) { return path.dirname(stateDir.dir); }
  return (firstWorkspaceFolder ?? '').trim();
}
