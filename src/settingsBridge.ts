/**
 * How every `sessionSitter.*` setting is set when there is no VS Code to set it in.
 *
 * ## Why a table rather than a convention
 *
 * The supervisor group already layers settings over the environment (`src/supervisorSettings.ts`), so
 * a headless run configures 19 of the 42 settings. The rest had no headless story at all, and no way
 * to notice: a setting the extension reads and a terminal cannot is invisible until someone on a build
 * box asks why their configuration does nothing.
 *
 * Naming this for each setting turns that into a build failure. `ci/check-settings.mjs` asserts every
 * declared setting appears here exactly once, so adding a setting to `package.json` without deciding
 * how a terminal sets it fails CI rather than shipping.
 *
 * ## Three kinds of equivalent, because there are genuinely three
 *
 * The honest question is not "does every setting have an environment variable" — it is "can a person
 * with no IDE configure this". Sometimes the answer is a flag, and sometimes the correct answer is
 * that there is nothing to configure:
 *
 *  - **`env`** — an environment variable (also read from a `.env` beside the working directory, via
 *    `loadConfig`). The default for anything the daemon, the hooks or the CLI act on.
 *  - **`flag`** — a command-line flag. Better than an environment variable where the setting is
 *    *consent* to something with a side effect: `--peers` opens SSH connections, and a flag typed at
 *    the moment of use is a clearer consent than a variable inherited from a shell profile.
 *  - **`ide`** — it configures the IDE surface, and there is no headless behaviour for it to change.
 *    A `workspaceColors` environment variable would be a knob wired to nothing, which is worse than
 *    its absence: it implies the terminal has a panel to colour.
 *
 * Every `ide` entry carries its reason, because "no equivalent needed" is a claim, and an unexplained
 * one is how a real gap gets filed under this heading and forgotten.
 */

/** How one setting is reached from outside VS Code. */
export type HeadlessEquivalent =
  | { kind: 'env'; name: string }
  | { kind: 'flag'; name: string; command: string }
  | { kind: 'ide'; why: string };

/**
 * Every `sessionSitter.*` setting, and how a terminal sets it.
 *
 * Keyed by the full setting id as `package.json` declares it. `ci/check-settings.mjs` compares the two
 * lists in both directions, so this cannot drift from the manifest.
 */
export const HEADLESS_EQUIVALENT: Readonly<Record<string, HeadlessEquivalent>> = {
  // ── The supervisor group ──────────────────────────────────────────────────
  // Already layered over the environment by `applySupervisorSettings`: a setting the user has
  // explicitly set wins, otherwise the variable, otherwise the built-in default. The variable names
  // are `loadConfig`'s and predate the settings.
  'sessionSitter.supervisor.engine': { kind: 'env', name: 'SUPERVISOR_ENGINE' },
  'sessionSitter.supervisor.bobCliPath': { kind: 'env', name: 'BOB_CLI_PATH' },
  'sessionSitter.supervisor.claudeCliPath': { kind: 'env', name: 'CLAUDE_CLI_PATH' },
  'sessionSitter.supervisor.bobApiKey': { kind: 'env', name: 'BOBSHELL_API_KEY' },
  'sessionSitter.supervisor.anthropicBaseUrl': { kind: 'env', name: 'ANTHROPIC_BASE_URL' },
  'sessionSitter.supervisor.anthropicAuthToken': { kind: 'env', name: 'ANTHROPIC_AUTH_TOKEN' },
  // `CLAUDE_TIMEOUT_SECONDS`, not `CLASSIFIER_TIMEOUT_SECONDS`: the variable predates the setting and
  // renaming it would break every `.env` that has it.
  'sessionSitter.supervisor.classifierTimeoutSeconds': {
    kind: 'env', name: 'CLAUDE_TIMEOUT_SECONDS',
  },
  'sessionSitter.supervisor.fastClassifier': { kind: 'env', name: 'FAST_CLASSIFIER' },
  'sessionSitter.supervisor.fastClassifierModel': { kind: 'env', name: 'FAST_CLASSIFIER_MODEL' },
  'sessionSitter.supervisor.fastClassifierTimeoutSeconds': {
    kind: 'env', name: 'FAST_CLASSIFIER_TIMEOUT_SECONDS',
  },
  'sessionSitter.supervisor.fastClassifierBaseUrl': {
    kind: 'env', name: 'FAST_CLASSIFIER_BASE_URL',
  },
  'sessionSitter.supervisor.orangeResponseTimeoutMinutes': {
    kind: 'env', name: 'ORANGE_RESPONSE_TIMEOUT_MINUTES',
  },
  'sessionSitter.supervisor.messagingChannel': { kind: 'env', name: 'MESSAGING_CHANNEL' },
  'sessionSitter.supervisor.telegramBotToken': { kind: 'env', name: 'TELEGRAM_BOT_TOKEN' },
  'sessionSitter.supervisor.telegramChatId': { kind: 'env', name: 'TELEGRAM_CHAT_ID' },
  'sessionSitter.supervisor.redNotify': { kind: 'env', name: 'RED_NOTIFY' },
  'sessionSitter.supervisor.notifyRuleDecisions': { kind: 'env', name: 'NOTIFY_RULE_DECISIONS' },
  'sessionSitter.supervisor.knowledgeRepo': { kind: 'env', name: 'KNOWLEDGE_REPO' },
  'sessionSitter.supervisor.knowledgeRef': { kind: 'env', name: 'KNOWLEDGE_REF' },

  // ── Knowledge routing ────────────────────────────────────────────────────
  // The hooks already read these three, which is how a plugin-only install routes its practices.
  'sessionSitter.knowledge.user': { kind: 'env', name: 'SESSION_SITTER_USER' },
  'sessionSitter.knowledge.project': { kind: 'env', name: 'SESSION_SITTER_PROJECT' },
  'sessionSitter.knowledge.team': { kind: 'env', name: 'SESSION_SITTER_TEAM' },
  'sessionSitter.knowledge.registryPath': { kind: 'env', name: 'KNOWLEDGE_REGISTRY_PATH' },

  // ── Paths ────────────────────────────────────────────────────────────────
  'sessionSitter.supervisorStateDir': { kind: 'env', name: 'STATE_DIR' },
  // Not an environment variable: the repo is derived from the working directory, so the headless
  // control is where you run from — and `--workspace-root` for saying so explicitly, which matters for
  // a service whose working directory is set by a unit file rather than by a shell.
  'sessionSitter.supervisorRepoPath': {
    kind: 'flag', name: '--workspace-root', command: 'session-sitter daemon',
  },
  'sessionSitter.dataRepoPath': { kind: 'env', name: 'KNOWLEDGE_LOCAL_REPO' },

  // ── The Telegram remote interface ────────────────────────────────────────
  // The first four had no headless equivalent at all, which is what this table was written to
  // surface: the daemon can hold the reader lease and mirror sessions, and until now it could not be
  // told to. The four that follow shape how much the mirror says, and they belong here for the same
  // reason — a machine with no IDE window is exactly where a flapping topic name goes unnoticed.
  'sessionSitter.telegram.remoteControl': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_REMOTE_CONTROL',
  },
  'sessionSitter.telegram.allowedUserIds': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS',
  },
  'sessionSitter.telegram.fullMessages': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_FULL_MESSAGES',
  },
  'sessionSitter.telegram.maxMessageParts': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS',
  },
  'sessionSitter.telegram.maxTurnsPerPass': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_MAX_TURNS_PER_PASS',
  },
  'sessionSitter.telegram.statusHoldSeconds': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_STATUS_HOLD_SECONDS',
  },
  'sessionSitter.telegram.mirrorToolActivity': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_MIRROR_TOOL_ACTIVITY',
  },
  'sessionSitter.telegram.toolActivitySeconds': {
    kind: 'env', name: 'SESSION_SITTER_TELEGRAM_TOOL_ACTIVITY_SECONDS',
  },

  // ── Consent, better expressed as a flag ──────────────────────────────────
  'sessionSitter.remotePeers': {
    kind: 'flag', name: '--peers', command: 'session-sitter status',
  },

  // ── The IDE surface ──────────────────────────────────────────────────────
  'sessionSitter.autoSupervise': {
    kind: 'ide',
    why: 'gates the supervision loop *inside a window*. The headless equivalent is not a setting but '
      + 'whether `session-sitter daemon` is running, which is a stronger and more visible control.',
  },
  'sessionSitter.autoRespond': {
    kind: 'ide',
    why: 'drives `AutoResponder`, which answers IBM Bob approval prompts through the VS Code '
      + 'extension host. There is no such prompt queue to answer on a terminal-only machine.',
  },
  'sessionSitter.sessionSort': {
    kind: 'ide',
    why: 'the panel\'s sort order. The terminal takes `--sort`, which is the same six orders and is '
      + 'per-invocation rather than persisted.',
  },
  'sessionSitter.workspaceColors': {
    kind: 'ide',
    why: 'colours the panel\'s session rows. A terminal has no rows to colour, and a variable wired '
      + 'to nothing would imply it did.',
  },
  'sessionSitter.windowAttentionMinutes': {
    kind: 'ide',
    why: 'how long a window keeps the attention badge in the VS Code UI.',
  },
  'sessionSitter.probelessActiveWindowMinutes': {
    kind: 'ide',
    why: 'how long a window is assumed active without an inspector probe — a property of the '
      + 'extension host\'s own liveness detection, which no terminal performs.',
  },
  'sessionSitter.debugCommands': {
    kind: 'ide',
    why: 'read by VS Code itself, as the `enablement` expression that hides the developer probe '
      + 'commands from the palette. No code reads its value, here or anywhere.',
  },
};

/** Every setting that a terminal configures through the environment, and the variable that does it. */
export function envNames(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [setting, how] of Object.entries(HEADLESS_EQUIVALENT)) {
    if (how.kind === 'env') { out[setting] = how.name; }
  }
  return out;
}

/** The variable a setting is read from, or null when it is not set through the environment. */
export function envNameFor(setting: string): string | null {
  const how = HEADLESS_EQUIVALENT[setting];
  return how !== undefined && how.kind === 'env' ? how.name : null;
}

// ── Reading the environment the way the settings are read ───────────────────

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/**
 * The `SettingsReader` the Telegram config wants, backed by the environment instead of VS Code.
 *
 * Keys are relative (`telegram.remoteControl`) exactly as the caller passes them, so the namespace
 * prefix is added here and the mapping table stays the only place a variable name appears.
 *
 * An unparseable value falls back rather than throwing. A malformed `.env` should not stop the daemon
 * starting; it should leave the setting at its default, which is what a missing value already does.
 */
export function envSettingsReader(env: NodeJS.ProcessEnv = process.env): {
  getBoolean(key: string, fallback: boolean): boolean;
  getStringArray(key: string, fallback: string[]): string[];
  getNumber(key: string, fallback: number): number;
} {
  const raw = (key: string): string | undefined => {
    const name = envNameFor(`sessionSitter.${key}`);
    if (name === null) { return undefined; }
    const value = env[name];
    return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
  };
  return {
    getBoolean: (key, fallback) => {
      const v = raw(key)?.toLowerCase();
      if (v === undefined) { return fallback; }
      if (TRUE.has(v)) { return true; }
      if (FALSE.has(v)) { return false; }
      return fallback;
    },
    getStringArray: (key, fallback) => {
      const v = raw(key);
      if (v === undefined) { return fallback; }
      // Comma or whitespace separated, because both are what people type into a shell profile, and a
      // list that silently keeps a stray space becomes an id that never matches.
      const items = v.split(/[,\s]+/).map(s => s.trim()).filter(s => s.length > 0);
      return items.length > 0 ? items : fallback;
    },
    getNumber: (key, fallback) => {
      const v = raw(key);
      if (v === undefined) { return fallback; }
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    },
  };
}

/**
 * Prefer what the user explicitly set in VS Code, and fall back to the environment.
 *
 * The same precedence `applySupervisorSettings` applies, and for the same reason: an existing
 * environment-based install keeps working, while a setting someone actually typed into the Settings UI
 * is never quietly overridden by a variable inherited from a shell.
 *
 * `explicit` returns `undefined` for "the user has not set this", which is why the VS Code side has to
 * use `inspect()` rather than `get()`. `get()` returns the manifest default for an unset setting, so
 * layering under it would make the environment unreachable for every setting that has a default —
 * which is all of them.
 */
export function layeredSettingsReader(
  explicit: {
    getBoolean(key: string): boolean | undefined;
    getStringArray(key: string): string[] | undefined;
    getNumber(key: string): number | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): {
  getBoolean(key: string, fallback: boolean): boolean;
  getStringArray(key: string, fallback: string[]): string[];
  getNumber(key: string, fallback: number): number;
} {
  const fromEnv = envSettingsReader(env);
  return {
    getBoolean: (key, fallback) => explicit.getBoolean(key) ?? fromEnv.getBoolean(key, fallback),
    getStringArray: (key, fallback) =>
      explicit.getStringArray(key) ?? fromEnv.getStringArray(key, fallback),
    getNumber: (key, fallback) => explicit.getNumber(key) ?? fromEnv.getNumber(key, fallback),
  };
}
