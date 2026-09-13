import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { queryBobDb } from './BobDatabase';
import { discoverPeers } from './remote/PeerDiscovery';
import { SshRunner } from './remote/SshRunner';
import {
  RemoteSessionSource,
  type PeerStatus,
  type RemoteOwner,
} from './remote/RemoteSessionSource';
import { REMOTE_FOCUS_PY } from './remote/remoteFocus';
import type { WindowEntry } from './WindowRegistry';
import { FullTranscript, readBobTranscript } from './SessionExporter';
import {
  parseSessionFile,
  scanBobSessions,
  scanChatSessions,
  scanClaudeSessions,
  scanCodexSessions,
  defaultStorePaths,
  vscodeUserDir,
  type ClaudeSession,
  type MessageExchange,
  type SessionSourceId,
} from './sessionScan';
// The exchange readers below still walk raw records; the status rules they used to live beside
// now belong to sessionStatus.ts.
import type { JsonlRecord } from './sessionStatus';

/**
 * How often peer machines are re-probed. Slower than the 5 s local poll on purpose: each pass is
 * network work, and with ControlMaster keeping the connection warm this is still responsive.
 */
const REMOTE_POLL_MS = 20_000;

/**
 * Whether to pull sessions from peer machines (`sessionSitter.remotePeers`).
 *
 * **Fails closed.** If the setting cannot be read — an unexpected host, a configuration API that
 * is absent or throws — the answer is no. The alternative would be opening SSH connections from a
 * host we could not even query for consent, which is precisely where the extension should do the
 * least. Only an explicit, readable `auto` turns it on.
 */
export function remotePeersEnabled(
  readSetting: () => string | undefined = () =>
    vscode.workspace.getConfiguration('sessionSitter').get<string>('remotePeers'),
): boolean {
  try {
    return (readSetting() ?? 'auto') !== 'off';
  } catch {
    return false;
  }
}
/**
 * Re-exported so every existing importer keeps working. These definitions moved into
 * `sessionScan` — the pure, `vscode`-free half of session detection that the terminal CLI reads
 * through — and only their home changed, not their names or their behaviour.
 */
export type { ClaudeSession, MessageExchange, SessionSourceId } from './sessionScan';
export { getActiveSessionIds, vscodeUserDir } from './sessionScan';

/** How much of each turn `getRecentExchanges` should return. */
export interface ExchangeOptions {
  /**
   * Return every character of each turn, and every text block of it, instead of a preview excerpt.
   *
   * For the Telegram mirror, which is a reader's only view of the session and splits a long turn
   * across several messages rather than cutting it off.
   */
  full?: boolean;
  /**
   * How many turns from the tail to return. Six by default — the panel's preview depth.
   *
   * The Telegram mirror asks for far more, and the reason is a bug this option exists to close. The
   * mirror tracks how far it has posted; if a session produces more turns between two passes than
   * this window holds, the ones that fell off the front are never seen by any pass and are lost from
   * the topic for good. A deeper window costs a few more parsed lines out of a tail that is read
   * either way.
   */
  limit?: number;
  /**
   * Also return the assistant turns that say nothing and activate a tool, as `kind: 'tool'`.
   *
   * Off by default, because the panel's preview bubbles and `AutoResponder` both want the
   * conversation and not the machinery. The Telegram mirror wants them: a session that spends ten
   * minutes editing files says nothing in that time, and a topic that shows nothing at all reads as
   * a session that has stopped.
   */
  includeTools?: boolean;
}

/** Turns `getRecentExchanges` returns when the caller does not say. The panel's preview depth. */
const DEFAULT_EXCHANGE_LIMIT = 6;

/**
 * How many turns to collect, from the option or the default.
 *
 * Floored at one rather than trusting the number: a hand-edited setting reaching here as `0` would
 * turn every reader into one that returns nothing, which looks exactly like a session with no
 * transcript.
 */
function exchangeLimit(opts: ExchangeOptions): number {
  const limit = opts.limit ?? DEFAULT_EXCHANGE_LIMIT;
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_EXCHANGE_LIMIT;
}

/**
 * Excerpt lengths for the panel's preview bubbles: enough to recognise a turn, not to read it.
 *
 * Asymmetric because the two roles are read differently — your own prompt you only need to
 * identify, whereas the answer is the thing being skimmed.
 */
const PREVIEW_CAPS = { user: 150, assistant: 250 } as const;

/** How much of the tail of a transcript is read for previews, and for full turns. */
const PREVIEW_TAIL_BYTES = 32768;
/**
 * A megabyte, for full mode.
 *
 * Not merely "more of the same": a single record larger than the window is not truncated but
 * *lost*, because the read starts mid-line and the JSON no longer parses. A long answer would
 * disappear from the mirror altogether, which is the one failure worse than a short one. Still a
 * partial read, and still bounded by collecting only the last few turns.
 */
const FULL_TAIL_BYTES = 1_048_576;

/** Cut a turn to its preview length, or leave it whole in full mode. */
function excerpt(text: string, role: 'user' | 'assistant', opts: ExchangeOptions): string {
  if (opts.full) { return text; }
  const cap = PREVIEW_CAPS[role];
  return text.length > cap ? text.slice(0, cap) + '…' : text;
}

/**
 * The text of a message's content, whether that is a bare string or a block array.
 *
 * In full mode every text block is joined; otherwise the first one wins. The difference matters
 * where an answer is interrupted by tool calls: the model's reasoning arrives as several text
 * blocks around them, and taking only the first hands back an opening sentence while the actual
 * answer sits in the block after the tool result.
 */
function textOfContent(content: unknown, opts: ExchangeOptions): string | null {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content.trim() : null;
  }
  if (!Array.isArray(content)) { return null; }
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type !== 'text' || typeof b.text !== 'string' || b.text.trim().length === 0) { continue; }
    parts.push(b.text.trim());
    if (!opts.full) { break; }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Keys worth showing beside a tool's name, in the order a reader would want them.
 *
 * A tool call's input is arbitrary JSON and most of it is noise on a phone: `Edit` carries the whole
 * replacement text, `Bash` a command that may be a page long. One field identifies the call —
 * *which* file, *which* command — and that is all a one-line sample is for.
 */
const TOOL_ARG_KEYS = [
  'file_path', 'notebook_path', 'path', 'command', 'pattern', 'query', 'url', 'description',
  'prompt', 'subagent_type',
] as const;

/**
 * A one-line summary of the tools an assistant record activates, or null when it activates none.
 *
 * Deliberately short. This is what the mirror posts as a sample of a working session, so its job is
 * to say *what the agent is doing* in the width of a Telegram bubble — `Edit(src/telegram/render.ts)`
 * — not to reproduce the call. Several blocks in one record are joined, because Claude batches
 * parallel tool calls into a single assistant message and reporting only the first would understate
 * what the agent did.
 */
export function toolActivityOfContent(content: unknown): string | null {
  if (!Array.isArray(content)) { return null; }
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: unknown };
    if (b.type !== 'tool_use' || typeof b.name !== 'string' || b.name.trim().length === 0) {
      continue;
    }
    parts.push(`${b.name.trim()}${toolArgument(b.input)}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The identifying argument of one tool call, parenthesised, or '' when nothing identifies it. */
function toolArgument(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) { return ''; }
  const record = input as Record<string, unknown>;
  for (const key of TOOL_ARG_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) { continue; }
    // First line only: a heredoc or a multi-line prompt would otherwise turn a one-line sample
    // into the very flood the sampling exists to avoid.
    const line = value.trim().split('\n')[0].trim();
    return `(${line.length > 80 ? `${line.slice(0, 79)}…` : line})`;
  }
  return '';
}

// Structured turn for full-transcript export. All fields optional so partial
// turns (e.g. a user message without a completed assistant response yet) are
// representable.
interface TranscriptTurn {
  userText?: string;
  assistantText?: string;
  timestamp?: Date;
}

interface TranscriptMeta {
  title: string;
  source: 'Claude' | 'Bob' | 'Codex' | 'Chat';
  sessionId: string;
}


// One row of Bob's `messages` table, as both Bob readers below consume it.
interface BobMessageRow {
  role: string;
  data: string;
  created_at: number;
}

// Bob's message rows for one task, oldest first. A constant — every value is bound as a
// parameter (see BobDatabase.queryBobDb).
const BOB_MESSAGES_SQL =
  "SELECT role, data, created_at FROM messages WHERE task_id=? "
  + "AND role IN ('user','assistant') ORDER BY created_at";

// Fingerprint used to skip firing the event when nothing changed.
function sessionsFingerprint(sessions: ClaudeSession[]): string {
  return sessions.map(s => `${s.sessionId}:${s.status}:${s.title}:${s.updatedAt.getTime()}`).join('|');
}

export class SessionManager implements vscode.Disposable {
  private readonly _onDidChangeSessions = new vscode.EventEmitter<ClaudeSession[]>();
  readonly onDidChangeSessions: vscode.Event<ClaudeSession[]> = this._onDidChangeSessions.event;

  private _sessions: ClaudeSession[] = [];
  private _sessionFilePaths = new Map<string, string>();
  private _sessionSources = new Map<string, SessionSourceId>();
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _projectsDir: string;
  private readonly _bobDbPath: string;
  private readonly _codexSessionsDir: string;
  private readonly _codexIndexPath: string;
  private readonly _vscodeUserDir: string;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _pollTimer: ReturnType<typeof setInterval>;
  // Present only when peer pulling is enabled; see `_startRemotePolling`.
  private _remote: RemoteSessionSource | undefined;
  private _remoteRunner: SshRunner | undefined;
  private _remoteTimer: ReturnType<typeof setInterval> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this._projectsDir = defaultStorePaths().projectsDir;
    this._bobDbPath = path.join(os.homedir(), '.bob', 'db', 'bob.db');
    this._codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    this._codexIndexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
    this._vscodeUserDir = vscodeUserDir();

    // Initial scan
    void this._scanSessions().then(sessions => {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    });

    // FileSystemWatcher as fast path (may not fire reliably in WSL2)
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this._projectsDir),
      '**/*.jsonl'
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const refresh = () => {
      if (this._debounceTimer !== undefined) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined;
        void this._runScan();
      }, 250);
    };

    this._watcher.onDidCreate(refresh);
    this._watcher.onDidChange(refresh);
    this._watcher.onDidDelete(refresh);

    // Watch Bob DB WAL file for changes (written on every transaction commit)
    const bobDbDir = path.dirname(this._bobDbPath);
    const bobDbName = path.basename(this._bobDbPath);
    const bobPattern = new vscode.RelativePattern(
      vscode.Uri.file(bobDbDir),
      `${bobDbName}-wal`,
    );
    const bobWatcher = vscode.workspace.createFileSystemWatcher(bobPattern);
    bobWatcher.onDidCreate(refresh);
    bobWatcher.onDidChange(refresh);
    context.subscriptions.push({ dispose: () => bobWatcher.dispose() });

    // Watch ~/.codex/session_index.jsonl for changes (Codex CLI updates it on every session write).
    const codexIndexDir = path.dirname(this._codexIndexPath);
    const codexIndexName = path.basename(this._codexIndexPath);
    const codexPattern = new vscode.RelativePattern(vscode.Uri.file(codexIndexDir), codexIndexName);
    const codexWatcher = vscode.workspace.createFileSystemWatcher(codexPattern);
    codexWatcher.onDidCreate(refresh);
    codexWatcher.onDidChange(refresh);
    context.subscriptions.push({ dispose: () => codexWatcher.dispose() });

    // Watch chatSessions/*.jsonl across all workspaces. Shared debounced `refresh`.
    const chatPattern = new vscode.RelativePattern(
      vscode.Uri.file(this._vscodeUserDir),
      'workspaceStorage/*/chatSessions/*.jsonl',
    );
    const chatWatcher = vscode.workspace.createFileSystemWatcher(chatPattern);
    chatWatcher.onDidCreate(refresh);
    chatWatcher.onDidChange(refresh);
    chatWatcher.onDidDelete(refresh);
    context.subscriptions.push({ dispose: () => chatWatcher.dispose() });

    // Polling fallback: re-scan every 5 s so status indicators and new sessions
    // stay current even when the FileSystemWatcher is silent (common in WSL2).
    this._pollTimer = setInterval(() => { void this._runScan(); }, 5_000);

    this._startRemotePolling();

    context.subscriptions.push(this);
  }

  /**
   * Start pulling sessions from peer machines, unless the user has turned it off.
   *
   * Deliberately on its own timer, slower than the local 5 s poll: `_scanSessions` awaits its
   * sources in sequence, so a peer probe on that path would stall the local session list behind
   * the network. This timer only refreshes a cache that the merge reads synchronously.
   */
  private _startRemotePolling(): void {
    // 'off' means no discovery, no timer, and no ssh connection of any kind.
    if (!remotePeersEnabled()) { return; }

    const runner = new SshRunner();
    // Shared with `focusRemoteSession`, so focus reuses the same warm ControlMaster connection.
    this._remoteRunner = runner;
    this._remote = new RemoteSessionSource({
      runner,
      discover: () => discoverPeers(),
      // The real parser, so a peer's session is titled by exactly the code that titles a local one.
      parseSessionFile: (filePath) => this._parseSessionFile(filePath),
    });

    const pull = async () => {
      try {
        await this._remote?.refresh();
        await this._runScan();
      } catch { /* a peer failure must never break the local panel */ }
    };
    void pull();
    this._remoteTimer = setInterval(() => { void pull(); }, REMOTE_POLL_MS);
  }

  /** Reachability of each peer machine, for display in the panel. */
  getPeerStatuses(): PeerStatus[] {
    return this._remote?.getPeerStatuses() ?? [];
  }

  /**
   * Live window entries published by peer machines.
   *
   * The panel unions these with `readLiveWindows` when deciding which sessions are open. Without
   * them a peer session can never be reported open — `readLiveWindows` sees only this machine —
   * so an idle peer session would always be filed under History.
   */
  getPeerWindows(): WindowEntry[] {
    return this._remote?.getPeerWindows() ?? [];
  }

  /** The peer window that owns a workspace path, for focusing a session on its own machine. */
  findRemoteOwnerWindow(projectPath: string): RemoteOwner | null {
    return this._remote?.findOwnerWindow(projectPath) ?? null;
  }

  /**
   * Bring the peer window that owns a session to the front, on its own machine.
   *
   * Returns false when this session is not on a peer, when no live peer window owns its
   * workspace, or when the peer window entry predates the fields the handshake needs.
   */
  async focusRemoteSession(sessionId: string): Promise<boolean> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session?.peer || !session.projectPath) { return false; }

    const owner = this.findRemoteOwnerWindow(session.projectPath);
    // An older build on the peer may not publish these, and without them there is nothing to talk to.
    if (!owner?.window.ipcSocket || !owner.window.ideCli) { return false; }

    const cfg = Buffer.from(JSON.stringify({
      pid: owner.window.pid,
      sessionId,
      ideCli: owner.window.ideCli,
      ipcSocket: owner.window.ipcSocket,
      folder: owner.window.workspaceFolders[0],
    }), 'utf8').toString('base64');

    try {
      await this._remoteRunner?.run(owner.peer, ['python3', '-', cfg], { stdin: REMOTE_FOCUS_PY });
      return true;
    } catch {
      return false;
    }
  }

  getSessions(): ClaudeSession[] {
    return [...this._sessions];
  }

  /** Path to Bob's SQLite DB (used by the supervision export bridge). */
  getBobDbPath(): string {
    return this._bobDbPath;
  }

  /** On-disk path for a session's source file (Claude/Codex/Chat JSONL; the id itself for
   *  Bob). Used by the supervision export. Undefined if the session isn't known. */
  getSessionFilePath(sessionId: string): string | undefined {
    return this._sessionFilePaths.get(sessionId);
  }

  /**
   * Full-fidelity transcript (tool calls + the pending approval) for the supervisor.
   * This extension is the single reader of the agents' stores; the supervisor consumes this
   * export contract rather than touching bob.db. Bob-only — Claude goes through
   * `SessionExporter.exportClaude`, which reads the session's JSONL file directly.
   */
  async getFullTranscript(sessionId: string): Promise<FullTranscript> {
    const source = this._sessionSources.get(sessionId);
    if (source && source !== 'bob') {
      throw new Error(`getFullTranscript: ${source} sessions are not supported (Bob only)`);
    }
    return readBobTranscript(this._bobDbPath, sessionId);
  }

  /**
   * Resolve the upload source file for a session:
   * - Claude sessions: returns the existing .jsonl file path.
   * - Bob sessions: serialises recent exchanges to a temp .bob.json file.
   * Returns { filePath, cleanup } or null if the session cannot be found.
   */
  async exportSessionAsJson(
    sessionId: string,
  ): Promise<{ filePath: string; cleanup: () => void } | null> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session) { return null; }

    if (session.source === 'claude' || session.source === 'codex') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      return { filePath, cleanup: () => { /* nothing to clean up */ } };
    }

    if (session.source === 'chat') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const exchanges = await this._getChatRecentExchanges(filePath);
      const envelope = {
        session_id: sessionId,
        harness: 'chat',
        username: os.userInfo().username,
        created_at: session.updatedAt.toISOString(),
        title: session.title,
        messages: exchanges.map(e => ({
          role: e.role,
          content: e.text,
          timestamp: e.timestamp ?? new Date().toISOString(),
        })),
      };
      const tmpFile = path.join(os.tmpdir(), `chat-session-${sessionId}.chat.json`);
      await fs.promises.writeFile(tmpFile, JSON.stringify(envelope, null, 2), 'utf8');
      return {
        filePath: tmpFile,
        cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
      };
    }

    // Bob session — build a minimal .bob.json envelope from DB data.
    const exchanges = await this._getBobRecentExchanges(sessionId);
    const envelope = {
      session_id: sessionId,
      harness: 'bob',
      username: os.userInfo().username,
      created_at: session.updatedAt.toISOString(),
      title: session.title,
      messages: exchanges.map(e => ({
        role: e.role,
        content: e.text,
        timestamp: e.timestamp ?? new Date().toISOString(),
      })),
    };

    const tmpFile = path.join(os.tmpdir(), `bob-session-${sessionId}.bob.json`);
    await fs.promises.writeFile(tmpFile, JSON.stringify(envelope, null, 2), 'utf8');
    return {
      filePath: tmpFile,
      cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
    };
  }

  /**
   * Return the full transcript of a session as handoff-clean markdown, or
   * null if the session cannot be found. Dispatches by _sessionSources.
   * User + assistant prose only — tool_use / tool_result / scaffolding stripped.
   */
  async exportFullTranscript(sessionId: string): Promise<string | null> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session) { return null; }

    if (session.source === 'codex') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const turns = await this._getCodexFullTranscript(filePath);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Codex session',
        source: 'Codex',
        sessionId,
      });
    }

    if (session.source === 'claude') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const turns = await this._getClaudeFullTranscript(filePath);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Claude session',
        source: 'Claude',
        sessionId,
      });
    }

    if (session.source === 'bob') {
      const turns = await this._getBobFullTranscript(sessionId);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Bob session',
        source: 'Bob',
        sessionId,
      });
    }

    if (session.source === 'chat') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const turns = await this._getChatFullTranscript(filePath);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Chat session',
        source: 'Chat',
        sessionId,
      });
    }

    return null;
  }

  private _renderTranscriptAsMarkdown(turns: TranscriptTurn[], meta: TranscriptMeta): string {
    const header = [
      `# ${meta.title}`,
      '',
      `*Copied from ${meta.source} · session \`${meta.sessionId}\` · ${turns.length} turn${turns.length === 1 ? '' : 's'}.*`,
      '',
      '---',
      '',
    ];
    const body: string[] = [];
    turns.forEach((turn, i) => {
      const when = turn.timestamp ? turn.timestamp.toISOString().replace('T', ' ').slice(0, 19) : '(no timestamp)';
      body.push(`## Turn ${i + 1}  ·  ${when}`, '');
      if (turn.userText) {
        body.push('**User:**', '', turn.userText, '');
      }
      if (turn.assistantText) {
        body.push(`**Assistant (${meta.source}):**`, '', turn.assistantText, '');
      }
      body.push('---', '');
    });
    return header.concat(body).join('\n');
  }


  /**
   * The last few turns of a session.
   *
   * Two callers with opposite needs share this. The panel draws preview bubbles a few lines tall,
   * so it wants an excerpt; the Telegram mirror is the only view of the session a person has when
   * they are away from the machine, so a 250-character excerpt there is unusable — the part of an
   * answer you need in order to reply is usually the end of it. `full` is that second caller.
   *
   * The default is the excerpt, unchanged to the character, because the panel and `AutoResponder`
   * both depend on it.
   */
  async getRecentExchanges(
    sessionId: string, opts: ExchangeOptions = {},
  ): Promise<MessageExchange[]> {
    const filePath = this._sessionFilePaths.get(sessionId);
    if (!filePath) { return []; }

    if (this._sessionSources.get(sessionId) === 'bob') {
      return this._getBobRecentExchanges(filePath, opts);
    }

    if (this._sessionSources.get(sessionId) === 'codex') {
      return this._getCodexRecentExchanges(filePath, opts);
    }

    if (this._sessionSources.get(sessionId) === 'chat') {
      return this._getChatRecentExchanges(filePath, opts);
    }


    let stat: { size: number };
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return [];
    }

    const TAIL = opts.full ? FULL_TAIL_BYTES : PREVIEW_TAIL_BYTES;
    const offset = Math.max(0, stat.size - TAIL);
    const size = stat.size - offset;
    const buf = Buffer.alloc(size);

    const fh = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      const collected: MessageExchange[] = [];
      const limit = exchangeLimit(opts);

      for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) { continue; }
        try {
          const record = JSON.parse(trimmed) as JsonlRecord;

          if (record.type === 'user') {
            const text = textOfContent(record.message?.content, opts);
            if (text !== null) {
              collected.push({
                role: 'user', text: excerpt(text, 'user', opts), timestamp: record.timestamp,
              });
            }

          } else if (record.type === 'assistant') {
            const text = textOfContent(record.message?.content, opts);
            if (text !== null) {
              collected.push({
                role: 'assistant',
                text: excerpt(text, 'assistant', opts),
                timestamp: record.timestamp,
              });
            } else if (opts.includeTools === true) {
              // An assistant record with no text is the agent using a tool. Kept as its own kind
              // rather than as text, so a caller can post every spoken turn and still sample these.
              const tools = toolActivityOfContent(record.message?.content);
              if (tools !== null) {
                collected.push({
                  role: 'assistant', text: tools, kind: 'tool', timestamp: record.timestamp,
                });
              }
            }
          }
        } catch {
          // Malformed line — skip
        }
      }

      return collected.reverse();
    } finally {
      await fh.close();
    }
  }

  dispose(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }
    clearInterval(this._pollTimer);
    if (this._remoteTimer !== undefined) {
      clearInterval(this._remoteTimer);
    }
    this._watcher.dispose();
    this._onDidChangeSessions.dispose();
  }

  private async _getBobRecentExchanges(
    taskId: string, opts: ExchangeOptions = {},
  ): Promise<MessageExchange[]> {
    let rows: BobMessageRow[];
    try {
      rows = await queryBobDb<BobMessageRow>(this._bobDbPath, BOB_MESSAGES_SQL, [taskId]);
    } catch {
      return [];
    }

    const collected: MessageExchange[] = [];
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data) as { content?: unknown };
        const text = textOfContent(d.content, opts);
        if (text === null) { continue; }
        const role = row.role === 'user' ? 'user' : 'assistant';
        collected.push({
          role,
          text: excerpt(text, role, opts),
          timestamp: new Date(row.created_at).toISOString(),
        });
      } catch { /* skip malformed */ }
    }

    return collected.slice(-exchangeLimit(opts));
  }

  // Return every message for a Bob task, chronologically. Uses the same
  // messages(role, data, created_at) schema as _getBobRecentExchanges — the
  // `data` column is a JSON blob containing {content}. Full history, no cap.
  private async _getBobFullTranscript(taskId: string): Promise<TranscriptTurn[]> {
    let rows: BobMessageRow[];
    try {
      rows = await queryBobDb<BobMessageRow>(this._bobDbPath, BOB_MESSAGES_SQL, [taskId]);
    } catch {
      return [];
    }

    const turns: TranscriptTurn[] = [];
    let pending: TranscriptTurn | null = null;

    for (const row of rows) {
      let text: string | null = null;
      try {
        const d = JSON.parse(row.data) as { content?: unknown };
        const content = d.content;
        if (typeof content === 'string' && content.trim()) {
          text = content.trim();
        } else if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && b.text?.trim()) { parts.push(b.text.trim()); }
          }
          if (parts.length > 0) { text = parts.join('\n\n'); }
        }
      } catch { /* skip malformed row */ }

      if (!text) { continue; }
      const ts = typeof row.created_at === 'number' ? new Date(row.created_at) : undefined;

      if (row.role === 'user') {
        if (pending) { turns.push(pending); }
        pending = { userText: text, timestamp: ts };
      } else if (row.role === 'assistant') {
        if (!pending) { pending = { timestamp: ts }; }
        pending.assistantText = pending.assistantText
          ? `${pending.assistantText}\n\n${text}`
          : text;
        if (!pending.timestamp) { pending.timestamp = ts; }
      }
    }
    if (pending) { turns.push(pending); }
    return turns;
  }

  // Run a full scan and fire onDidChangeSessions only when something changed.
  private async _runScan(): Promise<void> {
    const sessions = await this._scanSessions();
    if (sessionsFingerprint(sessions) !== sessionsFingerprint(this._sessions)) {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    }
  }

  private async _scanSessions(): Promise<ClaudeSession[]> {
    // Build the id->path and id->source maps into LOCAL maps and swap them in atomically at
    // the end, mirroring how `_sessions` is swapped. Clearing the live maps at the start of a
    // scan and repopulating them asynchronously lets a concurrent reader (e.g. the 5 s
    // supervision sweep calling `getSessionFilePath`) hit the emptied map mid-scan and see
    // `undefined` — which made the Claude supervision export report "no target session" on
    // every aligned tick. Never mutate the live maps in place.
    const filePaths = new Map<string, string>();
    const sources = new Map<string, SessionSourceId>();
    const claudeSessions = await this._scanClaudeSessions(filePaths, sources);
    const bobSessions = await this._scanBobSessions(filePaths, sources);
    const codexSessions = await this._scanCodexSessions(filePaths, sources);
    const chatSessions = await this._scanChatSessions(filePaths, sources);
    // Read synchronously from the cache the remote timer fills — never awaited on the network
    // here, so a slow or unreachable peer cannot delay the local session list.
    //
    // Remote ids are intentionally left out of `filePaths` and `sources`: those maps drive the
    // supervision export, which acts on the machine that owns the session. Registering a peer
    // session there would invite supervision to act on a transcript it cannot control.
    const remoteSessions = this._remote?.getSessions() ?? [];
    const merged = [
      ...claudeSessions, ...bobSessions, ...codexSessions, ...chatSessions, ...remoteSessions,
    ];
    merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    this._sessionFilePaths = filePaths;
    this._sessionSources = sources;
    return merged;
  }

  // Each scanner delegates to the pure reader in `sessionScan`. The wrappers stay because the
  // directory each one reads is instance state — the constructor derives it, and the tests point
  // it at a temp directory after construction.
  private _scanClaudeSessions(
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    return scanClaudeSessions(this._projectsDir, filePaths, sources);
  }

  private _scanBobSessions(
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    return scanBobSessions(this._bobDbPath, filePaths, sources);
  }

  private _scanCodexSessions(
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    return scanCodexSessions(this._codexSessionsDir, this._codexIndexPath, filePaths, sources);
  }

  private _scanChatSessions(
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    return scanChatSessions(this._vscodeUserDir, filePaths, sources);
  }

  private _parseSessionFile(filePath: string): Promise<ClaudeSession | null> {
    return parseSessionFile(filePath);
  }

  // Read the tail of a Codex rollout .jsonl and return the last `opts.limit` role-bearing
  // response_item records as MessageExchanges (user or assistant text only).
  private async _getCodexRecentExchanges(
    filePath: string, opts: ExchangeOptions = {},
  ): Promise<MessageExchange[]> {
    let stat: { size: number };
    try {
      stat = await fs.promises.stat(filePath);
    } catch { return []; }

    const TAIL = opts.full ? FULL_TAIL_BYTES : PREVIEW_TAIL_BYTES;
    const offset = Math.max(0, stat.size - TAIL);
    const size = stat.size - offset;
    const buf = Buffer.alloc(size);

    const fh = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      const collected: MessageExchange[] = [];

      const limit = exchangeLimit(opts);

      for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) { continue; }
        try {
          const rec = JSON.parse(trimmed) as {
            timestamp?: string;
            type?: string;
            payload?: { role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (rec.type !== 'response_item') { continue; }
          const role = rec.payload?.role;
          if (role !== 'user' && role !== 'assistant') { continue; }
          // Codex blocks carry no `type`, so they are selected on having text rather than on being
          // a text block — the same rule the `find` here always used, applied to all of them.
          const blocks = (rec.payload?.content ?? [])
            .filter(b => typeof b.text === 'string' && b.text.trim().length > 0)
            .map(b => (b.text as string).trim());
          if (blocks.length === 0) { continue; }
          const text = opts.full ? blocks.join('\n\n') : blocks[0];
          collected.push({ role, text: excerpt(text, role, opts), timestamp: rec.timestamp });
        } catch { /* skip malformed line */ }
      }
      return collected.reverse();
    } finally {
      await fh.close();
    }
  }

  // Walk every line of a Codex rollout and pair user/assistant response_item
  // records into TranscriptTurns. Different from _getCodexRecentExchanges
  // which tail-slices; this returns the full history.
  private async _getCodexFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const turns: TranscriptTurn[] = [];
    let pending: TranscriptTurn | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const rec = JSON.parse(trimmed) as {
          timestamp?: string;
          type?: string;
          payload?: { role?: string; content?: Array<{ type?: string; text?: string }> };
        };
        if (rec.type !== 'response_item') { continue; }
        const role = rec.payload?.role;
        if (role !== 'user' && role !== 'assistant') { continue; }
        const text = (rec.payload?.content ?? [])
          .filter(b => typeof b.text === 'string' && b.text.trim().length > 0)
          .map(b => b.text!.trim())
          .join('\n')
          .trim();
        if (!text) { continue; }
        const ts = rec.timestamp ? new Date(rec.timestamp) : undefined;
        if (role === 'user') {
          if (pending) { turns.push(pending); }
          pending = { userText: text, timestamp: ts };
        } else {
          if (!pending) { pending = { timestamp: ts }; }
          pending.assistantText = pending.assistantText
            ? `${pending.assistantText}\n\n${text}`
            : text;
          if (!pending.timestamp) { pending.timestamp = ts; }
        }
      } catch { /* skip malformed line */ }
    }
    if (pending) { turns.push(pending); }
    return turns;
  }

  // Walk every event in a Claude Code .jsonl and pair user/assistant events
  // into TranscriptTurns. Drops tool_use / tool_result / thinking parts.
  private async _getClaudeFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const turns: TranscriptTurn[] = [];
    let pending: TranscriptTurn | null = null;

    const extractText = (content: unknown): string => {
      if (typeof content === 'string') { return content.trim(); }
      if (!Array.isArray(content)) { return ''; }
      const parts = content
        .filter((p): p is { type: string; text?: string } =>
          typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text',
        )
        .map(p => (typeof p.text === 'string' ? p.text : ''))
        .filter(t => t.trim().length > 0)
        .map(t => t.trim());
      return parts.join('\n\n');
    };

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const rec = JSON.parse(trimmed) as {
          type?: string;
          timestamp?: string;
          message?: { role?: string; content?: unknown };
        };
        if (rec.type !== 'user' && rec.type !== 'assistant') { continue; }
        const text = extractText(rec.message?.content);
        if (!text) { continue; }
        const ts = rec.timestamp ? new Date(rec.timestamp) : undefined;
        if (rec.type === 'user') {
          if (pending) { turns.push(pending); }
          pending = { userText: text, timestamp: ts };
        } else {
          if (!pending) { pending = { timestamp: ts }; }
          pending.assistantText = pending.assistantText
            ? `${pending.assistantText}\n\n${text}`
            : text;
          if (!pending.timestamp) { pending.timestamp = ts; }
        }
      } catch { /* skip malformed line */ }
    }
    if (pending) { turns.push(pending); }
    return turns;
  }

  // Reconstruct the `v` state of a VS Code Chat session by replaying its
  // snapshot (kind:0) + deltas (kind:1 assign, kind:2 array push).
  private _replayChatDeltas(lines: string[]): {
    requests?: Array<{
      timestamp?: number;
      message?: { text?: string };
      response?: Array<{ value?: unknown }>;
      result?: { metadata?: { renderedUserMessage?: Array<{ type?: number; text?: string }> } };
    }>;
  } {
    const applyDelta = (
      state: Record<string, unknown> | unknown[],
      keyPath: Array<string | number>,
      value: unknown,
      isPush: boolean,
    ): void => {
      if (!keyPath.length) { return; }
      let parent: Record<string, unknown> | unknown[] = state;
      for (let i = 0; i < keyPath.length - 1; i++) {
        const k = keyPath[i];
        if (Array.isArray(parent) && typeof k === 'number') {
          while (parent.length <= k) { parent.push({}); }
          parent = parent[k] as Record<string, unknown> | unknown[];
        } else if (!Array.isArray(parent) && typeof k === 'string') {
          if (!(k in parent)) {
            parent[k] = typeof keyPath[i + 1] === 'number' ? [] : {};
          }
          parent = parent[k] as Record<string, unknown> | unknown[];
        }
      }
      const last = keyPath[keyPath.length - 1];
      if (isPush) {
        let arr: unknown;
        if (Array.isArray(parent) && typeof last === 'number') {
          arr = parent[last];
        } else if (!Array.isArray(parent) && typeof last === 'string') {
          if (!(last in parent)) { parent[last] = []; }
          arr = parent[last];
        }
        if (Array.isArray(arr) && Array.isArray(value)) { arr.push(...value); }
        else if (Array.isArray(arr)) { arr.push(value); }
      } else if (Array.isArray(parent) && typeof last === 'number') {
        while (parent.length <= last) { parent.push(undefined); }
        parent[last] = value;
      } else if (!Array.isArray(parent) && typeof last === 'string') {
        parent[last] = value;
      }
    };

    let state: Record<string, unknown> | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const rec = JSON.parse(trimmed) as { kind?: number; k?: Array<string | number>; v?: unknown };
        if (rec.kind === 0) {
          state = (rec.v as Record<string, unknown>) ?? {};
        } else if (state && (rec.kind === 1 || rec.kind === 2)) {
          applyDelta(state, rec.k ?? [], rec.v, rec.kind === 2);
        }
      } catch { /* skip malformed */ }
    }
    return (state ?? {}) as ReturnType<typeof this._replayChatDeltas>;
  }

  private async _getChatFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const state = this._replayChatDeltas(raw.split('\n'));
    const requests = state.requests ?? [];

    const USER_REQUEST_RE = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/;

    const turns: TranscriptTurn[] = [];
    for (const req of requests) {
      if (!req) { continue; }
      const rendered = req.result?.metadata?.renderedUserMessage ?? [];
      const combined = rendered
        .filter(p => p && p.type === 1 && typeof p.text === 'string')
        .map(p => p.text!)
        .join('\n');
      const unwrapMatch = combined.match(USER_REQUEST_RE);
      const userText = (unwrapMatch ? unwrapMatch[1] : (req.message?.text ?? combined)).trim();

      const assistantText = (req.response ?? [])
        .filter(el => el && typeof el.value === 'string')
        .map(el => el.value as string)
        .join('')
        .trim();

      const timestamp = typeof req.timestamp === 'number' ? new Date(req.timestamp) : undefined;

      if (userText || assistantText) {
        turns.push({
          userText: userText || undefined,
          assistantText: assistantText || undefined,
          timestamp,
        });
      }
    }
    return turns;
  }

  // Read the snapshot line of a VS Code Chat .jsonl and reconstruct the last
  // <= 3 request/response pairs as MessageExchanges (user text + concatenated
  // string `value` fields of the response array).
  private async _getChatRecentExchanges(
    filePath: string, opts: ExchangeOptions = {},
  ): Promise<MessageExchange[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const firstNl = raw.indexOf('\n');
    const firstLine = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
    if (!firstLine.trim()) { return []; }

    let snapshot: {
      v?: { requests?: Array<{
        message?: { text?: string };
        response?: Array<{ kind?: string; value?: unknown }>;
        timestamp?: number;
      }> };
    };
    try {
      snapshot = JSON.parse(firstLine);
    } catch { return []; }

    const requests = snapshot.v?.requests ?? [];
    const collected: MessageExchange[] = [];

    // A request is one user turn plus one answer, so half the turn budget covers it.
    const startIdx = Math.max(0, requests.length - Math.max(1, Math.floor(exchangeLimit(opts) / 2)));
    for (let i = startIdx; i < requests.length; i++) {
      const r = requests[i];
      const iso = typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : undefined;

      const userText = r.message?.text?.trim();
      if (userText) {
        collected.push({ role: 'user', text: excerpt(userText, 'user', opts), timestamp: iso });
      }

      const responseText = (r.response ?? [])
        .filter(el => typeof el.value === 'string')
        .map(el => el.value as string)
        .join('')
        .trim();
      if (responseText) {
        collected.push({
          role: 'assistant', text: excerpt(responseText, 'assistant', opts), timestamp: iso,
        });
      }
    }
    return collected;
  }

}

