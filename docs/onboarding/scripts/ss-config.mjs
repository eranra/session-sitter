#!/usr/bin/env node
/**
 * `ss-config.mjs` — the Session Sitter configuration doctor.
 *
 * This script exists so the onboarding skill never has to *remember* what Session Sitter can be
 * configured with. Every setting id, type, default, enum and range is read from the extension's
 * own declaration (`contributes.configuration` in `package.json`), so an agent driving the skill
 * validates against the build the user actually has rather than against its own recollection. A
 * setting that was renamed, removed or added shows up here the moment the extension does.
 *
 * Three commands:
 *
 *   where    every `settings.json` on this machine that could be the one to edit, newest first,
 *            flagged with whether it already carries `sessionSitter.*` keys. Editing the wrong
 *            file is the commonest way a configuration change appears to do nothing — on WSL and
 *            on a remote IDE there are several plausible files and only one of them is live.
 *
 *   schema   the declared settings as JSON: id, type, default, enum, range, scope. The skill
 *            reads this instead of hard-coding a list.
 *
 *   check    resolve settings + process env + `.env` files the way the extension does, validate
 *            the result, and report what is on, what is off, and why.
 *
 * Exit codes:  0 no errors (warnings allowed) · 1 at least one error · 2 bad usage.
 *
 * No dependencies, no network, and it never writes a file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

// ── Where the truth about settings comes from ───────────────────────────────

/**
 * Resolve the settings declaration, most authoritative source first. The order matters: a repo
 * checkout is the newest thing there is, an installed extension is what is actually running, and
 * the committed snapshot is the offline fallback for someone reading these docs with nothing
 * installed yet.
 */
function loadSchema({ packageJson, extensionsDir } = {}) {
  const tryPackage = (path, source) => {
    if (!path || !existsSync(path)) { return undefined; }
    let pkg;
    try { pkg = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
    if (pkg?.name !== 'session-sitter') { return undefined; }
    const flat = flattenDeclaration(pkg.contributes?.configuration);
    if (!flat) { return undefined; }
    return { source, path, version: pkg.version ?? null, settings: flat };
  };

  if (packageJson) {
    const explicit = tryPackage(resolve(packageJson), 'explicit --package');
    if (explicit) { return explicit; }
    fail(`--package ${packageJson} is not a Session Sitter package.json`);
  }

  // A repo checkout: walk up from this script. The repo root is three levels up, but walking is
  // what survives the folder being copied somewhere else.
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const found = tryPackage(join(dir, 'package.json'), 'repo checkout');
    if (found) { return found; }
    const up = dirname(dir);
    if (up === dir) { break; }
    dir = up;
  }

  for (const root of extensionsDir ? [resolve(extensionsDir)] : extensionRoots()) {
    if (!existsSync(root)) { continue; }
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    // `publisher.name-version`; the highest version wins when several are installed.
    const mine = entries.filter(e => e.startsWith('eranra.session-sitter-')).sort().reverse();
    for (const entry of mine) {
      const found = tryPackage(join(root, entry, 'package.json'), `installed extension (${root})`);
      if (found) { return found; }
    }
  }

  const snapshot = join(HERE, '..', 'reference', 'settings-schema.json');
  if (existsSync(snapshot)) {
    const snap = JSON.parse(readFileSync(snapshot, 'utf8'));
    return {
      source: 'committed snapshot', path: snapshot,
      version: snap.version ?? null, settings: snap.settings,
    };
  }
  fail('no settings declaration found — pass --package <path to a session-sitter package.json>');
}

/**
 * Extension directories worth looking in. Only builds whose `--extensions-dir` default is a
 * documented path are listed; any other build is reached with the explicit flag rather than by
 * guessing a directory that may not exist.
 */
function extensionRoots() {
  return [
    join(HOME, '.vscode', 'extensions'),
    join(HOME, '.vscode-server', 'extensions'),
    join(HOME, '.vscode-insiders', 'extensions'),
    join(HOME, '.cursor', 'extensions'),
    join(HOME, '.cursor-server', 'extensions'),
  ];
}

/**
 * `contributes.configuration` is one object or an array of titled sections — VS Code accepts
 * both, and this extension uses the array form so the Settings UI groups its settings under
 * headings. Flatten, keeping each setting's section title so a report can group the same way.
 */
function flattenDeclaration(configuration) {
  if (!configuration) { return undefined; }
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  const out = {};
  for (const section of sections) {
    for (const [id, decl] of Object.entries(section?.properties ?? {})) {
      out[id] = {
        section: section.title ?? null,
        type: decl.type,
        default: decl.default,
        enum: decl.enum ?? null,
        minimum: decl.minimum ?? null,
        maximum: decl.maximum ?? null,
        scope: decl.scope ?? 'window',
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Settings files on this machine ──────────────────────────────────────────

/**
 * Candidate `settings.json` paths, with what each one is.
 *
 * Several routinely coexist and only one is read by the running IDE. The classic trap is WSL: a
 * Windows-side VS Code with a WSL remote window keeps its **user** settings on the Windows side
 * under `/mnt/c`, while a Linux-side `~/.config/Code/User/settings.json` left over from a native
 * install sits there looking equally plausible and is never read. So every file found is reported
 * with its modification time and whether it carries `sessionSitter.*` keys, and the choice is
 * left to a human — a guess here silently edits the wrong file.
 */
function settingsCandidates(workspaceRoot) {
  const out = [];
  const push = (path, kind, note) => { if (existsSync(path)) { out.push({ path, kind, note }); } };

  const builds = [
    ['Code', 'VS Code'], ['Code - Insiders', 'VS Code Insiders'],
    ['VSCodium', 'VSCodium'], ['Cursor', 'Cursor'],
  ];
  for (const [dir, label] of builds) {
    push(join(HOME, '.config', dir, 'User', 'settings.json'), 'user', label);
    push(join(HOME, 'Library', 'Application Support', dir, 'User', 'settings.json'), 'user', `${label} (macOS)`);
  }
  if (process.env.APPDATA) {
    push(join(process.env.APPDATA, 'Code', 'User', 'settings.json'), 'user', 'VS Code (Windows)');
  }
  // A remote or WSL window: the server-side machine settings, read on the remote host.
  push(join(HOME, '.vscode-server', 'data', 'Machine', 'settings.json'), 'machine', 'VS Code Server (remote)');

  // WSL reaching the Windows-side user settings. Enumerated rather than globbed, so a machine
  // with no /mnt/c simply produces no result.
  const winUsers = '/mnt/c/Users';
  if (existsSync(winUsers)) {
    let users = [];
    try { users = readdirSync(winUsers); } catch { /* unreadable is not an error */ }
    for (const user of users) {
      for (const [dir, label] of builds) {
        push(join(winUsers, user, 'AppData', 'Roaming', dir, 'User', 'settings.json'),
          'user', `${label} on the Windows side (${user})`);
      }
    }
  }

  push(join(workspaceRoot, '.vscode', 'settings.json'), 'workspace', 'this workspace');

  for (const entry of out) {
    let raw = '';
    try { raw = readFileSync(entry.path, 'utf8'); } catch { /* listed but unreadable */ }
    entry.mtime = safeMtime(entry.path);
    entry.keys = Object.keys(parseJsonc(raw).value ?? {}).filter(k => k.startsWith('sessionSitter.'));
  }
  return out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
}

function safeMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * Parse the JSON-with-comments VS Code writes. Strings are respected, so a `//` inside a value —
 * a URL, or a regex in an `autoRespond` rule — survives rather than truncating the line.
 */
function parseJsonc(text) {
  let out = '';
  let inString = false, inLine = false, inBlock = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inLine) { if (ch === '\n') { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += ch;
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  // Trailing commas, which VS Code tolerates and `JSON.parse` does not.
  const cleaned = out.replace(/,(\s*[}\]])/g, '$1');
  if (!cleaned.trim()) { return { value: {}, error: null }; }
  try { return { value: JSON.parse(cleaned), error: null }; }
  catch (err) { return { value: null, error: String(err.message ?? err) }; }
}

// ── The environment layer, exactly as the extension builds it ───────────────

/**
 * A minimal `.env` parser matching `src/supervisor/config.ts`: `KEY=VALUE` lines, `#` comments,
 * optional surrounding quotes. A missing file is empty, never an error.
 */
function loadDotenv(path) {
  const values = {};
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return values; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) { continue; }
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === "'" || val[0] === '"')) {
      val = val.slice(1, -1);
    }
    if (key) { values[key] = val; }
  }
  return values;
}

/**
 * The `.env` layers the extension reads, lowest precedence first:
 * `<parent of workspace root>/.env` < `<workspace root>/.env` < `<workspace root>/.supervisor.env`.
 * `process.env` wins over all three.
 *
 * Note the location: `.supervisor.env` is read from the **workspace root** — which is
 * `sessionSitter.supervisorRepoPath` when set, else derived from an explicitly-set state dir, else
 * the first workspace folder. It is not read from your home directory.
 */
function envLayers(workspaceRoot) {
  const files = [
    join(dirname(workspaceRoot), '.env'),
    join(workspaceRoot, '.env'),
    join(workspaceRoot, '.supervisor.env'),
  ];
  const merged = Object.assign({}, ...files.map(loadDotenv));
  return { files: files.map(path => ({ path, present: existsSync(path) })), values: merged };
}

/**
 * `1 | true | yes | on` (case-insensitive, trimmed) is true; **every other value is false**. So
 * `RED_NOTIFY=0` and `RED_NOTIFY=off` both disable, and so does `RED_NOTIFY=maybe`.
 */
function envBool(raw) {
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Setting id → the environment variables the **extension** falls back to when the setting is unset,
 * in the order the code tries them.
 *
 * From `src/supervisor/config.ts`, `src/supervisorSettings.ts`, and the four `telegram.*` settings
 * that `src/extension.ts` layers through `layeredSettingsReader`.
 *
 * **This is not the same list as `HEADLESS_EQUIVALENT` in `src/settingsBridge.ts`**, and conflating
 * the two is the trap. That table answers "how does a terminal — the daemon, the CLI, the hooks —
 * configure this setting", and it names an equivalent for all 38. This one answers "what does the
 * *extension* read when the setting is blank", which is the question a `settings.json` review asks.
 * `STATE_DIR` is the clearest divergence: it is the daemon's way to set the state directory, and the
 * extension passes `sessionSitter.supervisorStateDir` straight through without ever reading it.
 */
const ENV_FALLBACKS = {
  'sessionSitter.supervisor.engine': ['SUPERVISOR_ENGINE'],
  'sessionSitter.supervisor.bobCliPath': ['BOB_CLI_PATH'],
  'sessionSitter.supervisor.claudeCliPath': ['CLAUDE_CLI_PATH'],
  'sessionSitter.supervisor.bobApiKey': ['BOBSHELL_API_KEY', 'BOB_API_KEY'],
  'sessionSitter.supervisor.anthropicBaseUrl': ['ANTHROPIC_BASE_URL'],
  'sessionSitter.supervisor.anthropicAuthToken': ['ANTHROPIC_AUTH_TOKEN'],
  'sessionSitter.supervisor.classifierTimeoutSeconds': ['CLAUDE_TIMEOUT_SECONDS'],
  'sessionSitter.supervisor.fastClassifier': ['FAST_CLASSIFIER'],
  'sessionSitter.supervisor.fastClassifierModel': ['FAST_CLASSIFIER_MODEL'],
  'sessionSitter.supervisor.fastClassifierTimeoutSeconds': ['FAST_CLASSIFIER_TIMEOUT_SECONDS'],
  'sessionSitter.supervisor.fastClassifierBaseUrl': ['FAST_CLASSIFIER_BASE_URL'],
  'sessionSitter.supervisor.messagingChannel': ['MESSAGING_CHANNEL'],
  'sessionSitter.supervisor.telegramBotToken': ['TELEGRAM_BOT_TOKEN'],
  'sessionSitter.supervisor.telegramChatId': ['TELEGRAM_CHAT_ID'],
  'sessionSitter.supervisor.orangeResponseTimeoutMinutes': ['ORANGE_RESPONSE_TIMEOUT_MINUTES'],
  'sessionSitter.supervisor.redNotify': ['RED_NOTIFY'],
  'sessionSitter.supervisor.notifyRuleDecisions': ['NOTIFY_RULE_DECISIONS'],
  'sessionSitter.dataRepoPath': ['KNOWLEDGE_LOCAL_REPO', 'KB_SITTER_LOCAL_REPO'],
  'sessionSitter.supervisor.knowledgeRepo': ['KNOWLEDGE_REPO', 'KB_SITTER_KNOWLEDGE_REPO'],
  'sessionSitter.supervisor.knowledgeRef': ['KNOWLEDGE_REF'],
  'sessionSitter.knowledge.registryPath': ['KNOWLEDGE_REGISTRY_PATH'],
  // The remote-interface settings, layered by `layeredSettingsReader` in `src/extension.ts`.
  'sessionSitter.telegram.remoteControl': ['SESSION_SITTER_TELEGRAM_REMOTE_CONTROL'],
  'sessionSitter.telegram.allowedUserIds': ['SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS'],
  'sessionSitter.telegram.fullMessages': ['SESSION_SITTER_TELEGRAM_FULL_MESSAGES'],
  'sessionSitter.telegram.maxMessageParts': ['SESSION_SITTER_TELEGRAM_MAX_MESSAGE_PARTS'],
  'sessionSitter.telegram.maxTurnsPerPass': ['SESSION_SITTER_TELEGRAM_MAX_TURNS_PER_PASS'],
  'sessionSitter.telegram.statusHoldSeconds': ['SESSION_SITTER_TELEGRAM_STATUS_HOLD_SECONDS'],
  'sessionSitter.telegram.mirrorToolActivity': ['SESSION_SITTER_TELEGRAM_MIRROR_TOOL_ACTIVITY'],
  'sessionSitter.telegram.toolActivitySeconds': ['SESSION_SITTER_TELEGRAM_TOOL_ACTIVITY_SECONDS'],
};

/**
 * How a **terminal** sets a setting the extension does not read from the environment: the daemon,
 * the CLI and the hooks, per `HEADLESS_EQUIVALENT` in `src/settingsBridge.ts`.
 *
 * Reported rather than resolved. A `--sort` flag typed at a `session-sitter status` invocation says
 * nothing about what the extension will do with `sessionSitter.sessionSort`, so folding these into
 * the resolution above would make the report wrong about the IDE.
 */
const HEADLESS_ONLY = {
  'sessionSitter.knowledge.user': 'env SESSION_SITTER_USER',
  'sessionSitter.knowledge.project': 'env SESSION_SITTER_PROJECT',
  'sessionSitter.knowledge.team': 'env SESSION_SITTER_TEAM',
  'sessionSitter.supervisorStateDir': 'env STATE_DIR (the daemon and CLI; the extension passes its own setting)',
  'sessionSitter.supervisorRepoPath': 'flag --workspace-root (session-sitter daemon)',
  'sessionSitter.remotePeers': 'flag --peers (session-sitter status)',
  'sessionSitter.sessionSort': 'flag --sort (session-sitter status) — per invocation, not persisted',
  'sessionSitter.autoSupervise': 'no equivalent: whether `session-sitter daemon` is running is the headless control',
  'sessionSitter.autoRespond': 'no equivalent: there is no IDE approval-prompt queue to answer on a terminal-only machine',
  'sessionSitter.workspaceColors': 'no equivalent: a terminal has no session rows to colour',
  'sessionSitter.windowAttentionMinutes': 'no equivalent: an IDE-window property',
  'sessionSitter.probelessActiveWindowMinutes': 'no equivalent: extension-host liveness detection',
  'sessionSitter.debugCommands': 'no equivalent: read by VS Code itself, to hide the developer commands',
};

/** Environment variables with no `sessionSitter.*` setting behind them. */
const ENV_ONLY = {
  ANTHROPIC_MODEL: "the agent's own model; the fast classifier judges with it by default",
  SESSION_SITTER_PRACTICES: 'Claude Code plugin: path to a practices file',
  SESSION_SITTER_MODE: 'Claude Code plugin: enforce | observe',
  SESSION_SITTER_CLASSIFIER: 'Claude Code plugin: may an ambiguous call spawn the classifier CLI',
  SESSION_SITTER_PRETOOL: 'Claude Code plugin: enforce red clauses on calls that never prompt',
  SESSION_SITTER_ESCALATE: 'Claude Code plugin: may the last rung ask a human before failing closed (needs a running daemon)',
  SESSION_SITTER_ESCALATE_WAIT: 'Claude Code plugin: seconds that rung waits, capped at 55',
  SESSION_SITTER_PERSIST_RULES: 'Claude Code plugin: may a green clause return a standing permission rule',
  SESSION_SITTER_RULE_DESTINATION: 'Claude Code plugin: where such a rule is written',
  SESSION_SITTER_USER: 'Claude Code plugin: knowledge routing, user tier',
  SESSION_SITTER_PROJECT: 'Claude Code plugin: knowledge routing, project tier',
  SESSION_SITTER_TEAM: 'Claude Code plugin: knowledge routing, team tier',
  SESSION_SITTER_DATA_DIR: 'Claude Code plugin: where the audit trail is written',
};

// ── Validation ──────────────────────────────────────────────────────────────

/** The colour names `sessionSitter.workspaceColors` accepts, from `src/workspaceColors.ts`. */
const WORKSPACE_COLOR_NAMES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue',
  'indigo', 'violet', 'purple', 'magenta', 'pink', 'brown', 'slate', 'gray', 'grey',
];

/** Settings that were declared once, are read by nothing now, and are silently ignored. */
const REMOVED = {
  'sessionSitter.uploadScriptPath':
    'the uploader is built in — set sessionSitter.dataRepoPath to your corpus root instead',
  'sessionSitter.pythonPath':
    'the supervisor is TypeScript and runs in-process; reading Bob\'s SQLite store uses the python3 on your PATH',
};

/** Tools that are never auto-approved, whatever a rule says. */
const QUESTION_TOOLS = ['ask_followup_question', 'AskUserQuestion'];

/** The fields an `autoRespond` rule may carry, and the decisions it may take. */
const RULE_FIELDS = ['matchPattern', 'response', 'toolPattern', 'argumentPattern', 'decision', 'sessionPattern', 'source'];
const RULE_DECISIONS = ['approveOnce', 'approveForTask', 'reject'];

function validate({ schema, files, env, workspaceRoot }) {
  const findings = [];
  const add = (level, code, message, fix) => findings.push({ level, code, message, fix });

  // Merge in VS Code's own precedence order: workspace folder > workspace > user. Applying the
  // layers low-to-high leaves `merged` holding what actually wins.
  const rank = { user: 0, machine: 1, workspace: 2 };
  const merged = {};
  const origin = {};
  for (const file of [...files].sort((a, b) => (rank[a.kind] ?? 0) - (rank[b.kind] ?? 0))) {
    if (file.parseError) {
      add('error', 'settings-unparsable',
        `${file.path} is not valid JSON: ${file.parseError}`,
        'fix the syntax first — VS Code is ignoring the whole file, not just the bad line');
      continue;
    }
    for (const [key, value] of Object.entries(file.settings)) {
      if (!key.startsWith('sessionSitter.')) { continue; }
      merged[key] = value;
      origin[key] = file;
    }
  }

  // ── Each key against the declaration ─────────────────────────────────────
  for (const [key, value] of Object.entries(merged)) {
    const decl = schema.settings[key];
    if (!decl) {
      if (REMOVED[key]) {
        add('warn', 'removed-key',
          `${key} was removed and is read by nothing — ${REMOVED[key]}`,
          `delete ${key} from ${origin[key].path}`);
      } else {
        const near = nearest(key, Object.keys(schema.settings));
        add('error', 'unknown-key',
          `${key} is not a declared setting, so it is silently ignored`
          + (near ? ` — did you mean ${near}?` : ''),
          `delete it from ${origin[key].path}` + (near ? `, or rename it to ${near}` : ''));
      }
      continue;
    }

    const actual = jsonType(value);
    if (actual !== decl.type) {
      add('error', 'wrong-type',
        `${key} is ${actual} but is declared ${decl.type}, so VS Code uses the default `
        + `(${JSON.stringify(decl.default)}) instead`,
        `write it as ${decl.type}`);
      continue;
    }
    if (decl.enum && !decl.enum.includes(value)) {
      add('error', 'bad-enum',
        `${key} is ${JSON.stringify(value)}, which is not one of `
        + decl.enum.map(v => JSON.stringify(v)).join(', '),
        `use one of ${decl.enum.join(' | ')}`);
    }
    if (decl.type === 'number') {
      if (decl.minimum !== null && value < decl.minimum) {
        add('error', 'out-of-range',
          `${key} is ${value}, below its minimum of ${decl.minimum}`,
          `raise it to at least ${decl.minimum}`);
      }
      if (decl.maximum !== null && value > decl.maximum) {
        add('error', 'out-of-range',
          `${key} is ${value}, above its maximum of ${decl.maximum}`,
          `lower it to at most ${decl.maximum}`);
      }
    }

    // A credential in a workspace file is a credential heading for a commit.
    if (decl.scope === 'machine' && origin[key].kind === 'workspace' && String(value).trim() !== '') {
      add('error', 'credential-in-workspace',
        `${key} holds a credential and is set in a workspace settings file `
        + `(${origin[key].path}), which is often committed`,
        'move it to your user settings, or to the environment or a git-ignored .env file');
    }
  }

  const colours = merged['sessionSitter.workspaceColors'];
  if (colours && jsonType(colours) === 'object') {
    for (const [pattern, colour] of Object.entries(colours)) {
      if (!isWorkspaceColour(colour)) {
        add('warn', 'bad-colour',
          `sessionSitter.workspaceColors["${pattern}"] is ${JSON.stringify(colour)}, which is not a `
          + 'colour, so that pill stays on the theme colour',
          `use a hex value (#0f8, #1a2b3c), "auto", or one of: ${WORKSPACE_COLOR_NAMES.join(', ')}`);
      }
    }
  }

  findings.push(...validateRules(merged['sessionSitter.autoRespond']));

  // ── What is actually switched on ─────────────────────────────────────────
  //
  // Resolution matches the extension: an explicitly-set setting wins, then the process
  // environment, then the `.env` layers, then the declared default.
  const resolved = key => {
    const own = merged[key];
    if (own !== undefined && !(typeof own === 'string' && own.trim() === '')) {
      return { value: own, from: 'setting' };
    }
    for (const name of ENV_FALLBACKS[key] ?? []) {
      if (process.env[name]) { return { value: process.env[name], from: `process env ${name}` }; }
      if (env.values[name]) { return { value: env.values[name], from: `.env ${name}` }; }
    }
    return { value: schema.settings[key]?.default, from: 'default' };
  };
  const truthy = key => {
    const r = resolved(key);
    return typeof r.value === 'boolean' ? r.value : envBool(r.value);
  };
  const text = key => {
    const v = resolved(key).value;
    return typeof v === 'string' ? v.trim() : '';
  };

  const stateDir = text('sessionSitter.supervisorStateDir');
  if (!stateDir) {
    add('info', 'supervisor-off',
      'the AI supervisor is off, because sessionSitter.supervisorStateDir is unset. Deterministic '
      + 'autoRespond rules still apply, and are still recorded and shown in the Supervision '
      + 'activity panel.',
      'set sessionSitter.supervisorStateDir to a writable directory to turn the supervisor on');
  } else {
    if (!existsSync(stateDir)) {
      add('warn', 'state-dir-missing',
        `sessionSitter.supervisorStateDir points at ${stateDir}, which does not exist yet`,
        'the extension creates it on first use — create it now if you would rather check permissions first');
    }
    if (!truthy('sessionSitter.autoSupervise')) {
      add('info', 'auto-supervise-off',
        'a state directory is set but sessionSitter.autoSupervise is false, so no prompt reaches '
        + 'the supervisor on its own',
        'set it true, or classify on demand with the "Supervise the Blocked Session Now" command');
    }
  }

  const engine = text('sessionSitter.supervisor.engine') || 'bob';
  if (stateDir && engine === 'bob' && !text('sessionSitter.supervisor.bobApiKey')) {
    add('warn', 'engine-needs-key',
      'the classifier engine is "bob" but no Bob API key resolves from settings, the environment '
      + 'or a .env file',
      'set sessionSitter.supervisor.bobApiKey, or BOBSHELL_API_KEY / BOB_API_KEY, or switch the engine to "claude"');
  }

  const channel = text('sessionSitter.supervisor.messagingChannel') || 'stub';
  const botToken = text('sessionSitter.supervisor.telegramBotToken');
  const chatId = text('sessionSitter.supervisor.telegramChatId');
  if (channel === 'telegram' && (!botToken || !chatId)) {
    add('error', 'telegram-incomplete',
      `the messaging channel is "telegram" but ${botToken ? 'no chat id' : 'no bot token'} resolves, `
      + 'so cards fall back to the stub channel (files under <stateDir>/notifications/)',
      'set the bot token and chat id, in settings or as TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
  }

  // The allowlist resolves from the environment too, and `envSettingsReader` splits that value on
  // commas *or* whitespace — both being what people type into a shell profile, and a list keeping a
  // stray space becomes an id that never matches.
  const allowedResolved = resolved('sessionSitter.telegram.allowedUserIds');
  const allowed = Array.isArray(allowedResolved.value)
    ? allowedResolved.value
    : String(allowedResolved.value ?? '').split(/[,\s]+/).filter(Boolean);
  if (truthy('sessionSitter.telegram.remoteControl')) {
    if (allowed.length === 0) {
      add('error', 'remote-control-no-allowlist',
        'sessionSitter.telegram.remoteControl is on but sessionSitter.telegram.allowedUserIds is '
        + 'empty, which authorises nobody, so the feature does not start',
        'add your numeric Telegram user id — the Session Sitter output channel logs the id of every rejected sender');
    }
    if (!botToken) {
      add('error', 'remote-control-no-token',
        'sessionSitter.telegram.remoteControl is on but no bot token resolves, so the feature does not start',
        'set TELEGRAM_BOT_TOKEN in the environment or a .env file — one bot per machine');
    }
    if (chatId && !chatId.startsWith('-')) {
      add('warn', 'chat-id-not-a-group',
        `the chat id ${chatId} is not negative, so it is not a group — and Topics cannot be enabled `
        + 'in a one-to-one chat',
        'use the id of a group with Topics enabled; a supergroup id starts with -100');
    }
    if (botToken && origin['sessionSitter.supervisor.telegramBotToken']) {
      add('warn', 'token-in-settings',
        'the bot token is in settings while remote control is on. Settings Sync would copy it to '
        + 'every machine, and two machines polling one token take each other\'s messages',
        'move the token to the environment or a .env file, and give each machine its own bot');
    }
  }

  if (stateDir && truthy('sessionSitter.supervisor.fastClassifier')) {
    const gateway = text('sessionSitter.supervisor.fastClassifierBaseUrl')
      || text('sessionSitter.supervisor.anthropicBaseUrl');
    const token = text('sessionSitter.supervisor.anthropicAuthToken');
    const model = text('sessionSitter.supervisor.fastClassifierModel')
      || process.env.ANTHROPIC_MODEL || env.values.ANTHROPIC_MODEL || '';
    const missing = [!gateway && 'gateway', !token && 'token', !model && 'model'].filter(Boolean);
    if (missing.length) {
      add('info', 'fast-classifier-inert',
        `the fast classifier is on but stays inactive: it resolves no ${missing.join(' and no ')}. `
        + 'Ambiguous actions go to the agent CLI, which is the behaviour without it — expected on a '
        + 'Claude subscription signed in through OAuth, where no token or gateway is set.',
        'to enable it, set a gateway and a token — fastClassifierBaseUrl or anthropicBaseUrl, plus '
        + 'anthropicAuthToken (or ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)');
    }
  }

  const localRepo = text('sessionSitter.dataRepoPath');
  const knowledgeRepo = text('sessionSitter.supervisor.knowledgeRepo');
  const slugs = ['user', 'project', 'team'].filter(tier => text(`sessionSitter.knowledge.${tier}`));
  if (slugs.length && !localRepo && !knowledgeRepo) {
    add('warn', 'knowledge-no-source',
      `knowledge slugs are set (${slugs.join(', ')}) but there is no knowledge source, so no tier `
      + 'file can be read',
      'set sessionSitter.dataRepoPath to a local corpus checkout (preferred), or '
      + 'sessionSitter.supervisor.knowledgeRepo to its git URL');
  }
  if (localRepo && !existsSync(localRepo)) {
    add('error', 'path-missing',
      `sessionSitter.dataRepoPath points at ${localRepo}, which does not exist`,
      'correct the path, or clear the setting');
  } else if (localRepo && !existsSync(join(localRepo, 'data', 'knowledge'))) {
    add('warn', 'corpus-layout',
      `${localRepo} has no data/knowledge/ directory, so no tier file will be found under it`,
      'point sessionSitter.dataRepoPath at the corpus repo root — the directory containing data/knowledge/');
  }
  for (const key of ['sessionSitter.supervisorRepoPath', 'sessionSitter.knowledge.registryPath']) {
    const path = text(key);
    if (path && !existsSync(path)) {
      add('error', 'path-missing',
        `${key} points at ${path}, which does not exist`,
        'correct the path, or clear the setting');
    }
  }

  if (Object.keys(merged).length === 0) {
    add('info', 'nothing-configured',
      'no sessionSitter.* setting is set in any settings file found, so the session panel is '
      + 'running on defaults and everything optional is off',
      'that is a valid state — the panel itself needs no configuration');
  }

  return { findings, merged, origin, resolved, workspaceRoot };
}

/** Every check that concerns only `sessionSitter.autoRespond`. */
function validateRules(rules) {
  const findings = [];
  const add = (level, code, message, fix) => findings.push({ level, code, message, fix });
  if (rules === undefined) { return findings; }
  if (!Array.isArray(rules)) {
    add('error', 'wrong-type',
      'sessionSitter.autoRespond must be an array of rule objects',
      'write it as an array; [] means no rules');
    return findings;
  }

  // Reachability is per source, because `AutoResponder` partitions the array before matching: the
  // Bob sweep sees only `source` unset or "bob", the Claude sweep only `source: "claude"`. A
  // catch-all in one lane shadows nothing in the other. Approval and text rules are also matched
  // by separate functions, so an approval catch-all never shadows a text rule.
  const catchAll = { bob: null, claude: null };

  rules.forEach((rule, i) => {
    const at = `sessionSitter.autoRespond[${i}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      add('error', 'rule-shape', `${at} is not an object`, 'each rule is a JSON object');
      return;
    }
    for (const field of Object.keys(rule)) {
      if (!RULE_FIELDS.includes(field)) {
        add('warn', 'rule-unknown-field',
          `${at} has an unrecognised field "${field}", which is ignored`,
          `remove it — the fields are ${RULE_FIELDS.join(', ')}`);
      }
    }

    // The extension's own type guards: a rule is a text rule when it has matchPattern AND
    // response, an approval rule when it has toolPattern AND decision. Half a pair is a rule
    // that parses, loads, and never fires.
    const isText = typeof rule.matchPattern === 'string' && typeof rule.response === 'string';
    const isApproval = typeof rule.toolPattern === 'string' && typeof rule.decision === 'string';
    if (!isText && !isApproval) {
      const half = typeof rule.matchPattern === 'string' ? 'matchPattern without response'
        : typeof rule.response === 'string' ? 'response without matchPattern'
          : typeof rule.toolPattern === 'string' ? 'toolPattern without decision'
            : typeof rule.decision === 'string' ? 'decision without toolPattern'
              : 'neither pair present';
      add('error', 'rule-shape',
        `${at} is neither a text rule nor an approval rule (${half}), so it never fires`,
        'a text rule needs matchPattern + response; an approval rule needs toolPattern + decision');
      return;
    }
    if (isApproval && !RULE_DECISIONS.includes(rule.decision)) {
      add('error', 'rule-shape',
        `${at}.decision is ${JSON.stringify(rule.decision)}, which is not one of `
        + RULE_DECISIONS.join(', '),
        `use one of ${RULE_DECISIONS.join(' | ')}`);
    }
    if (rule.source !== undefined && rule.source !== 'bob' && rule.source !== 'claude') {
      add('error', 'rule-shape',
        `${at}.source is ${JSON.stringify(rule.source)} — only "bob" (the default) and "claude" exist`,
        'use "bob" or "claude"');
    }
    for (const field of ['matchPattern', 'argumentPattern', 'sessionPattern']) {
      if (typeof rule[field] !== 'string') { continue; }
      try { new RegExp(rule[field]); }
      catch (err) {
        add('error', 'rule-bad-regex',
          `${at}.${field} is not a valid JavaScript regex (${err.message}), so the whole rule is skipped`,
          'fix the pattern — remember JSON needs every backslash doubled');
      }
    }

    // `AutoResponder.sweepClaudeApprovals` filters to `source === 'claude' && !sessionPattern`:
    // channel-to-session mapping does not exist for Claude, so a scoped Claude approval rule is
    // skipped rather than mis-applied. Silently never firing is worth an error.
    if (isApproval && rule.source === 'claude' && rule.sessionPattern) {
      add('error', 'rule-claude-scoped',
        `${at} is a Claude approval rule carrying a sessionPattern, and those are skipped — Claude `
        + 'approvals cannot be tied to a session yet, so a scoped rule is dropped rather than '
        + 'applied to the wrong session',
        'remove sessionPattern from this rule, or make it a Bob rule');
    }
    if (isApproval && QUESTION_TOOLS.some(tool => rule.toolPattern.includes(tool))) {
      add('info', 'rule-question-tool',
        `${at} names a user-facing question tool, which is never auto-approved whatever a rule `
        + 'says — resolving one through the approval channel makes the agent report that you gave '
        + 'no answer at all',
        'remove the rule; this guard cannot be overridden');
    }
    const lane = rule.source === 'claude' ? 'claude' : 'bob';
    if (isApproval && catchAll[lane] !== null) {
      add('warn', 'rule-unreachable',
        `${at} can never be reached: sessionSitter.autoRespond[${catchAll[lane]}] matches every tool `
        + `in the same lane (source "${lane}") with no session scope, and the first match wins`,
        `move this rule above sessionSitter.autoRespond[${catchAll[lane]}]`);
    }
    if (isApproval && rule.toolPattern === '*' && !rule.sessionPattern && catchAll[lane] === null) {
      catchAll[lane] = i;
    }
  });
  return findings;
}

function isWorkspaceColour(value) {
  if (typeof value !== 'string') { return false; }
  const text = value.trim().toLowerCase();
  if (text === 'auto' || WORKSPACE_COLOR_NAMES.includes(text)) { return true; }
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(text);
}

function jsonType(value) {
  if (Array.isArray(value)) { return 'array'; }
  if (value === null) { return 'null'; }
  if (typeof value === 'number') { return 'number'; }
  if (typeof value === 'boolean') { return 'boolean'; }
  if (typeof value === 'string') { return 'string'; }
  return 'object';
}

/** The declared key closest to a typo, so `unknown-key` can suggest the fix. */
function nearest(key, candidates) {
  let best, bestScore = Infinity;
  for (const candidate of candidates) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestScore) { bestScore = d; best = candidate; }
  }
  // Past a third of the length a "suggestion" is noise, so offer nothing.
  return bestScore <= Math.max(3, Math.floor(key.length / 3)) ? best : undefined;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdWhere(opts) {
  const files = settingsCandidates(opts.workspaceRoot);
  if (opts.json) { print(JSON.stringify({ files }, null, 2)); return 0; }
  if (files.length === 0) {
    print('No settings.json found. VS Code writes one the first time you change any setting.');
    return 0;
  }
  print('Settings files on this machine, most recently modified first:\n');
  for (const file of files) {
    const when = file.mtime ? new Date(file.mtime).toISOString().replace('T', ' ').slice(0, 16) : '?';
    const keys = file.keys.length ? `${file.keys.length} sessionSitter.* key(s)` : 'no sessionSitter.* keys';
    print(`  ${file.path}`);
    print(`      ${file.kind.padEnd(9)} ${file.note} · modified ${when} · ${keys}`);
  }
  print('\nSeveral of these can exist while only one is read by the IDE you are using. The live one');
  print('is the file whose keys the panel reflects — on WSL that is usually the Windows-side file,');
  print('not a Linux-side leftover. Confirm which one before editing.');
  return 0;
}

function cmdSchema(opts) {
  const schema = loadSchema(opts);
  print(JSON.stringify({
    source: schema.source, path: schema.path, version: schema.version,
    envFallbacks: ENV_FALLBACKS, headlessOnly: HEADLESS_ONLY, envOnly: ENV_ONLY,
    settings: schema.settings,
  }, null, 2));
  return 0;
}

function cmdCheck(opts) {
  const schema = loadSchema(opts);
  const workspaceRoot = opts.workspaceRoot;
  const chosen = opts.settings.length
    ? opts.settings.map(path => ({ path: resolve(path), kind: opts.kind ?? 'user', note: 'given with --settings' }))
    : settingsCandidates(workspaceRoot).filter(file => file.keys.length > 0);

  const files = chosen.map(file => {
    let raw = '';
    try { raw = readFileSync(file.path, 'utf8'); }
    catch (err) { return { ...file, settings: {}, keys: [], parseError: `cannot be read (${err.code ?? err.message})` }; }
    const parsed = parseJsonc(raw);
    return {
      ...file,
      mtime: file.mtime ?? safeMtime(file.path),
      settings: parsed.value ?? {},
      parseError: parsed.error,
      keys: Object.keys(parsed.value ?? {}).filter(k => k.startsWith('sessionSitter.')),
    };
  });

  const env = envLayers(workspaceRoot);
  const result = validate({ schema, files, env, workspaceRoot });
  const errors = result.findings.filter(f => f.level === 'error').length;
  const warnings = result.findings.filter(f => f.level === 'warn').length;

  if (opts.json) {
    print(JSON.stringify({
      schema: { source: schema.source, path: schema.path, version: schema.version },
      workspaceRoot,
      files: files.map(f => ({ path: f.path, kind: f.kind, keys: f.keys, parseError: f.parseError })),
      envFiles: env.files,
      settings: result.merged,
      findings: result.findings,
      summary: { errors, warnings, notes: result.findings.length - errors - warnings },
    }, null, 2));
    return errors ? 1 : 0;
  }

  print(`Settings declaration: ${schema.source}${schema.version ? ` (v${schema.version})` : ''}`);
  print(`                      ${schema.path}`);
  print(`Workspace root:       ${workspaceRoot}`);
  print('');
  print('Settings files read:');
  if (files.length === 0) { print('  (none found carrying sessionSitter.* keys)'); }
  for (const file of files) {
    print(`  ${file.kind.padEnd(9)} ${file.path} — ${file.keys.length} key(s)`);
  }
  print('');
  print('Environment files (lowest precedence first; the process environment wins over all):');
  for (const file of env.files) {
    print(`  ${file.present ? 'present' : 'absent '} ${file.path}`);
  }
  print('');
  print(featureSummary(result));

  if (result.findings.length) {
    print('\nFindings:');
    const rank = { error: 0, warn: 1, info: 2 };
    const label = { error: 'ERROR', warn: 'WARN ', info: 'note ' };
    for (const f of [...result.findings].sort((a, b) => rank[a.level] - rank[b.level])) {
      print(`\n  ${label[f.level]} [${f.code}] ${f.message}`);
      if (f.fix) { print(`        → ${f.fix}`); }
    }
  }

  print('');
  print(errors
    ? `${errors} error(s) and ${warnings} warning(s). Each error above stops something from working.`
    : `no errors, ${warnings} warning(s).`);
  return errors ? 1 : 0;
}

/** What is switched on — derived from the resolved values, so the report cannot flatter the config. */
function featureSummary(result) {
  const value = key => result.resolved(key).value;
  const on = flag => (flag ? 'on ' : 'off');
  const stateDir = String(value('sessionSitter.supervisorStateDir') ?? '').trim();
  const rules = result.merged['sessionSitter.autoRespond'];
  const ruleCount = Array.isArray(rules) ? rules.length : 0;
  return [
    'What is switched on:',
    '  session panel            on  — needs no configuration',
    `  autoRespond rules        ${on(ruleCount)} — ${ruleCount} rule(s)`,
    `  AI supervisor            ${on(stateDir)} — ${stateDir ? `state dir ${stateDir}` : 'no state dir set'}`,
    `  messaging channel        ${String(value('sessionSitter.supervisor.messagingChannel') ?? 'stub')}`,
    `  Telegram remote control  ${on(value('sessionSitter.telegram.remoteControl'))}`,
    `  fast classifier          ${on(value('sessionSitter.supervisor.fastClassifier'))}`,
    `  cross-machine sessions   ${String(value('sessionSitter.remotePeers') ?? 'auto')}`,
  ].join('\n');
}

// ── Entry point ─────────────────────────────────────────────────────────────

function print(line) { process.stdout.write(line + '\n'); }

function fail(message) {
  process.stderr.write(`ss-config: ${message}\n`);
  process.exit(2);
}

const USAGE = `ss-config.mjs — the Session Sitter configuration doctor

  node ss-config.mjs where  [--json] [--workspace-root DIR]
  node ss-config.mjs schema [--package PATH] [--extensions-dir DIR]
  node ss-config.mjs check  [--settings PATH]... [--kind user|workspace|machine]
                            [--workspace-root DIR] [--json]
                            [--package PATH] [--extensions-dir DIR]

  where    list every settings.json this machine has, so you edit the live one
  schema   print the settings the installed extension declares, as JSON
  check    validate a configuration, and report what is on, what is off, and why

Exit: 0 no errors · 1 errors found · 2 bad usage`;

function main(argv) {
  const opts = { settings: [], workspaceRoot: process.cwd(), json: false, kind: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { fail(`${arg} needs a value`); }
      return v;
    };
    switch (arg) {
      case '-h': case '--help': print(USAGE); return 0;
      case '--json': opts.json = true; break;
      case '--settings': opts.settings.push(next()); break;
      case '--kind': opts.kind = next(); break;
      case '--workspace-root': opts.workspaceRoot = resolve(next()); break;
      case '--package': opts.packageJson = next(); break;
      case '--extensions-dir': opts.extensionsDir = next(); break;
      default:
        if (arg.startsWith('-')) { fail(`unknown flag ${arg}`); }
        rest.push(arg);
    }
  }
  if (opts.kind && !['user', 'workspace', 'machine'].includes(opts.kind)) {
    fail('--kind must be user, workspace or machine');
  }
  switch (rest[0] ?? 'check') {
    case 'where': return cmdWhere(opts);
    case 'schema': return cmdSchema(opts);
    case 'check': return cmdCheck(opts);
    default: return fail(`unknown command "${rest[0]}" — one of where, schema, check`);
  }
}

process.exit(main(process.argv.slice(2)));
