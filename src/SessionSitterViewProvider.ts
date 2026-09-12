import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { SessionManager, ClaudeSession, MessageExchange } from './SessionManager';
import { readLiveWindows, writeWindowEntry, removeWindowEntry, discoverOwnIpcSocket, detectIdeCli, isAttendedWindow, type WindowEntry } from './WindowRegistry';
import { getOpenBobTaskIds } from './agents/BobInspector';
import { getOpenClaudeSessionIds } from './agents/ClaudeInspector';
import { BUILD_TIME, BUILD_VERSION } from './buildInfo';
import { SupervisionActivity, type ActivityItem } from './SupervisionActivity';
import { uploadSession } from './corpus/upload';
import {
  DEFAULT_SESSION_SORT, SESSION_SORT_MODES, sortSessions, toSessionSortMode,
  type SessionSortMode,
} from './sessionSort';
import { resolveWorkspaceColor, type WorkspaceBadgeColor } from './workspaceColors';
import { resolveDisplayStatus } from './sessionStatus';
import type { HookStates } from './HookActivityWatcher';
import {
  DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES, partitionByActivity,
} from './sessionActivity';

// The Sessions view is a live worklist: only sessions the user can currently act on.
// Everything else goes to History. Both partitions stay sorted by recency and capped.
// What counts as active lives in `sessionActivity.ts`, because Telegram applies the same rule.
const SESSIONS_LIMIT = 20;
const HISTORY_LIMIT = 50;

// How long a partition snapshot may be served to an outside caller before it is recomputed.
// `_partitionSessions` runs the Bob and Claude probes, and the Telegram loop asks far more often
// than the panel repaints; a couple of seconds is fresh enough for a chat message and stops the
// inspector being hit on every pass.
const PARTITION_CACHE_MS = 2_000;

/**
 * How often the panel repaints on its own, with no change to react to.
 *
 * The panel needs a clock because every age bound it applies is measured against `Date.now()` at
 * the moment `_partitionSessions` runs — the 2h `working` fallback and the probeless recency window
 * in `isActiveSession`, the 24h finished→dormant split in `resolveDisplayStatus`, and the pruning of
 * a dead window's session ids by `readLiveWindows`. Every *other* repaint trigger is a change
 * signal, and the one that matters most is gated: `onDidChangeSessions` fires only when
 * `sessionsFingerprint` moves, and that stops moving for good once a session's raw status settles on
 * a transcript nobody will write to again.
 *
 * So without this timer a bound is not a bound. A row that should have aged out hours ago keeps the
 * verdict the panel last reached, until something unrelated happens in the fleet and the whole list
 * silently corrects itself at once — which is exactly how it was found: a day-old session sat at the
 * top of the worklist until a new session was started somewhere else.
 *
 * Fifteen seconds because the shortest bound it serves is two hours. Finer buys nothing and each
 * tick costs two inspector round-trips into other extension hosts.
 */
const PANEL_REPAINT_MS = 15_000;

/** Key under which the last-viewed timestamps live in the extension's global state. */
export const LAST_VIEWED_KEY = 'sessionSitter.lastViewed';

/**
 * How the panel learns about a live pending approval or question.
 *
 * Keyed by session id, so only agents whose pending approvals name their session can appear
 * here. That is Bob: its approvals carry the owning task id. **Claude's do not** — they carry a
 * comms channel id, and the channel-to-session mapping is not available (the same reason
 * `AutoResponder` cannot honour `sessionPattern` for Claude rules). So a Claude session's
 * blocked state is inferred from its transcript instead; see `sessionStatus.ts`.
 */
export type PendingBySession = ReadonlyMap<string, 'approval' | 'question'>;

/**
 * A session as the webview receives it: the session itself plus whatever display decoration
 * applies to it. Decoration is resolved here rather than in the webview because the settings it
 * depends on are only readable from the extension host.
 */
type SessionRow = ClaudeSession & { workspaceColor?: WorkspaceBadgeColor };

/**
 * `sessionSitter.workspaceColors` as read from settings: pattern → colour. Values are validated in
 * `workspaceColors.ts`, not here, because a hand-edited setting can hold anything.
 *
 * Spelled as its own alias so `ci/check-settings.mjs` can see the read: it matches the setting id
 * inside a typed `get(...)` call, and a type argument containing its own angle brackets defeats
 * that match — which would report the setting as declared but never read.
 */
type WorkspaceColorRules = Record<string, unknown>;

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export class SessionSitterViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sessionSitter.view';

  private _view?: vscode.WebviewView;
  private _viewDisposables: vscode.Disposable[] = [];
  private _historyOpen = false;
  /**
   * When this window was last interacted with, as published in its registry entry.
   *
   * Held here rather than recomputed per publish because the publish timer keeps firing while
   * nobody is there — the point of the stamp is that it stops advancing.
   */
  private _lastActiveAt = Date.now();
  private _focusWatcher: vscode.Disposable | undefined;
  private _registryTimer: ReturnType<typeof setInterval> | undefined;
  private _activity: SupervisionActivity | undefined;
  private _lastActivity: ActivityItem[] = [];
  /** Last partition served to an outside caller, so the probes are not re-run on every ask. */
  private _partitionCache: {
    at: number; value: { active: ClaudeSession[]; history: ClaudeSession[]; current: string | null };
  } | undefined;
  private readonly _recordsDir: string;
  private readonly _notificationsDir: string;
  /** Where a decision card is delivered — see `setMessagingChannel`. */
  private _messagingChannel = 'stub';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessionManager: SessionManager,
    private readonly _log: (msg: string) => void = () => { /* no-op */ },
    stateDir = '',
    // Where "you have already read this" is remembered, and how a live pending approval reaches
    // the row. Both optional: without them the panel still works, it just cannot tell a result
    // you have read from one you have not, and Bob rows fall back to their database status.
    private readonly _memento?: vscode.Memento,
    private readonly _pendingBySession?: () => PendingBySession,
    // What the plugin's hooks observed, for the sessions that run them. Optional like the two above:
    // without it Claude rows fall back to the transcript inference and its 45-second latency.
    private readonly _hookStates?: () => HookStates,
  ) {
    this._recordsDir = stateDir ? path.join(stateDir, 'records') : '';
    this._notificationsDir = stateDir ? path.join(stateDir, 'notifications') : '';
    this._focusWatcher = this._startFocusRequestWatcher();
    void this._publishWindowEntry();
    this._registryTimer = setInterval(() => { void this._publishWindowEntry(); }, 60_000);

    // Observability feed: mirror the supervisor's decisions (records/) into the panel.
    if (stateDir) {
      this._activity = new SupervisionActivity(stateDir, items => {
        this._lastActivity = items;
        this._postActivity(items);
      });
      this._activity.start();
    }
  }

  /**
   * Which channel a decision card is delivered on (`sessionSitter.supervisor.messagingChannel`).
   *
   * The panel has to name where a card awaiting your answer actually went, and only the effective
   * supervisor config knows — the setting layers over `.env`. Extension activation builds that
   * config after the view provider, so it is handed over here rather than read here.
   */
  public setMessagingChannel(channel: string): void {
    this._messagingChannel = (channel || 'stub').toLowerCase();
    if (this._lastActivity.length) { this._postActivity(this._lastActivity); }
  }

  private _postActivity(items: ActivityItem[]): void {
    void this._view?.webview.postMessage({
      type: 'updateActivity',
      items,
      // The panel used to say a card was awaiting you "on Telegram" whatever the channel was. With
      // the default `stub` it is a file under the state dir, so that sent you to check nothing.
      channel: this._messagingChannel,
      notificationsDir: this._notificationsDir,
    });
  }

  /**
   * Resolve a supervision record's JSON path from its requestId (records live at
   * `<stateDir>/records/<requestId>.json`). Returns '' when no state dir is configured or the id
   * is malformed — the requestId must match the store's `req-<hex>` shape, so a value coming
   * from the webview can never escape the records directory.
   */
  private _supervisionRecordPath(requestId: string | undefined): string {
    if (!this._recordsDir || !requestId || !/^req-[A-Za-z0-9]+$/.test(requestId)) { return ''; }
    return path.join(this._recordsDir, `${requestId}.json`);
  }

  // Publish this window's identity + IPC socket so other windows can focus it.
  private async _publishWindowEntry(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    // `active` is 1.85; the manifest allows older hosts, and there it reads `undefined`. Treated as
    // "someone is here", which leaves the stamp always fresh and the rule that reads it inert —
    // the only safe direction, since the alternative hides sessions on hosts that cannot answer.
    const active = (vscode.window.state as { active?: boolean }).active;
    if (active !== false) { this._lastActiveAt = Date.now(); }
    await writeWindowEntry({
      pid: process.pid,
      workspaceFolders: folders,
      ideCli: detectIdeCli(undefined, vscode.env.appName),
      ipcSocket: discoverOwnIpcSocket() ?? process.env.VSCODE_IPC_HOOK_CLI ?? '',
      openBobTaskIds: await getOpenBobTaskIds(this._log),
      openClaudeSessionIds: (await getOpenClaudeSessionIds(this._log)).open,
      updatedAt: Date.now(),
      lastActiveAt: this._lastActiveAt,
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Refresh when session file metadata changes (status, titles)
    this._viewDisposables.push(
      this._sessionManager.onDidChangeSessions(() => {
        void this._pushSessions();
        if (this._historyOpen) { void this._pushHistory(); }
      })
    );

    // Repaint when the settings that shape the list change. Both are edited by hand as often as
    // through the panel — a colour map especially — and a change you cannot see applied looks
    // like a setting that does not work.
    this._viewDisposables.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('sessionSitter.sessionSort')
          && !event.affectsConfiguration('sessionSitter.workspaceColors')) { return; }
        void this._pushSessions();
        if (this._historyOpen) { void this._pushHistory(); }
      })
    );

    // Repaint on a clock, not only on a change. See PANEL_REPAINT_MS: every age bound the panel
    // applies is read from `Date.now()` when the partition runs, and the change signals above cannot
    // see time pass — a settled session's fingerprint never moves again.
    //
    // Skipped while the view is hidden. Each tick runs the Bob and Claude probes over the V8
    // inspector, which is not worth spending on a panel nobody is looking at, and revealing the view
    // resolves it again and repaints anyway.
    const repaintTimer = setInterval(() => {
      if (!webviewView.visible) { return; }
      void this._pushSessions();
      if (this._historyOpen) { void this._pushHistory(); }
    }, PANEL_REPAINT_MS);
    // Into `_viewDisposables` rather than a field: that list is cleared at the top of this method, so
    // re-resolving the view replaces this timer instead of leaving a second one ticking.
    this._viewDisposables.push({ dispose: () => clearInterval(repaintTimer) });

    // Refresh when Claude Code tabs open, close, or get renamed (tabGroups API added in VS Code 1.65)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { onDidChangeTabs: vscode.Event<unknown> } | undefined;
    if (tabGroups) {
      this._viewDisposables.push(
        tabGroups.onDidChangeTabs(() => {
          void this._pushSessions();
          if (this._historyOpen) { void this._pushHistory(); }
        })
      );
    }

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(async message => {
        switch (message.type) {
          case 'switchSession': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            // You are looking at it now, so its result is no longer unread. Stamped on the click
            // rather than on a successful focus: you have seen the row either way, and a failed
            // window switch leaving it marked unread would just make the panel argue with you.
            void this._markViewed(sessionId);
            void this._tryFocusForeignWindow(sessionId).then(result => {
              if (result === 'local') {
                void this._openSessionLocal(sessionId);
              } else if (result === 'foreign-failed') {
                void vscode.window.showWarningMessage('Could not switch to the window containing this session.');
              }
            });
            break;
          }
          case 'newSession': {
            this._openNewSession();
            break;
          }
          case 'newBobSession': {
            void vscode.commands.executeCommand('bob-code.task.pickWorkspace');
            break;
          }
          case 'removeTab': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            this._closeTabForSession(sessionId);
            break;
          }
          case 'setSessionSort': {
            await this._setSessionSort(message.mode);
            break;
          }
          case 'loadHistory': {
            this._historyOpen = true;
            void this._pushHistory();
            break;
          }
          case 'closeHistory': {
            this._historyOpen = false;
            break;
          }
          case 'addFromHistory': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._markViewed(sessionId);
            const allSessions = this._sessionManager.getSessions();
            const histSession = allSessions.find(s => s.sessionId === sessionId);
            if (histSession?.source === 'bob') {
              void vscode.commands.executeCommand('bobChatView.focus');
            } else if (histSession?.source === 'codex') {
              void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
            } else if (histSession?.source === 'chat') {
              void vscode.commands.executeCommand('workbench.action.chat.open');
            } else {
              // Same rule as switching: a history row can still be live in this window
              // (the side bar especially), so focus it there rather than duplicating it.
              await this._openClaudeSessionLocal(sessionId);
            }
            break;
          }
          case 'ready': {
            void this._pushSessions();
            if (this._lastActivity.length) { this._postActivity(this._lastActivity); }
            this._activity?.pushNow();
            break;
          }
          case 'getSessionPreview': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId || !this._view) { break; }
            const exchanges: MessageExchange[] = await this._sessionManager.getRecentExchanges(sessionId);
            const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
            void this._view.webview.postMessage({
              type: 'sessionPreview',
              sessionId,
              projectPath: session?.projectPath ?? '',
              exchanges,
            });
            break;
          }
          case 'openSettings': {
            // `query` jumps straight to one group of settings. With none, defer to the
            // `sessionSitter.openSettings` command, which owns the "all of them" filter.
            const query = message.query as string | undefined;
            if (query) {
              void vscode.commands.executeCommand('workbench.action.openSettings', query);
            } else {
              void vscode.commands.executeCommand('sessionSitter.openSettings');
            }
            break;
          }
          case 'loadActivity': {
            this._activity?.pushNow();
            break;
          }
          case 'openSupervisionRecord': {
            const recordPath = this._supervisionRecordPath(message.requestId as string | undefined);
            if (!recordPath) { break; }
            void vscode.workspace.openTextDocument(vscode.Uri.file(recordPath)).then(
              doc => vscode.window.showTextDocument(doc),
              () => vscode.window.showWarningMessage(`Supervision record not found: ${recordPath}`),
            );
            break;
          }
          case 'copySupervisionRecordPath': {
            const recordPath = this._supervisionRecordPath(message.requestId as string | undefined);
            if (!recordPath) { break; }
            void vscode.env.clipboard.writeText(recordPath);
            break;
          }
          case 'uploadToCorpus': {
            const sessionId = message.sessionId as string | undefined;
            if (!sessionId) { break; }
            void this._uploadSessionToCorpus(sessionId);
            break;
          }
          case 'copyToClipboard': {
            const text = message.text as string | undefined;
            if (typeof text === 'string') {
              void vscode.env.clipboard.writeText(text);
            }
            break;
          }
          case 'copyTranscriptToEditor': {
            const sid = message.sessionId as string | undefined;
            if (!sid) { break; }
            void (async () => {
              const md = await this._sessionManager.exportFullTranscript(sid);
              if (md === null) {
                void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
                return;
              }
              const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
              await vscode.window.showTextDocument(doc);
            })();
            break;
          }
          case 'copyTranscriptToClipboard': {
            const sid = message.sessionId as string | undefined;
            if (!sid) { break; }
            void (async () => {
              const md = await this._sessionManager.exportFullTranscript(sid);
              if (md === null) {
                void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
                return;
              }
              await vscode.env.clipboard.writeText(md);
              const bytes = Buffer.byteLength(md, 'utf8');
              vscode.window.setStatusBarMessage(
                `Transcript copied — ${(bytes / 1024).toFixed(1)} KB`,
                4000,
              );
            })();
            break;
          }
          case 'copyTranscriptToFile': {
            const sid = message.sessionId as string | undefined;
            if (!sid) { break; }
            void (async () => {
              const md = await this._sessionManager.exportFullTranscript(sid);
              if (md === null) {
                void vscode.window.showWarningMessage(`Session ${sid} no longer exists.`);
                return;
              }
              const tmpPath = path.join(os.tmpdir(), `transcript-${sid}.md`);
              await fs.promises.writeFile(tmpPath, md, 'utf8');
              const pick = await vscode.window.showInformationMessage(
                `Transcript saved: ${tmpPath}`,
                'Reveal in Finder',
              );
              if (pick === 'Reveal in Finder') {
                void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(tmpPath));
              }
            })();
            break;
          }
        }
      })
    );

    this._viewDisposables.push(
      vscode.window.onDidChangeWindowState(() => { void this._publishWindowEntry(); })
    );

    this._viewDisposables.push(
      webviewView.onDidDispose(() => { this._view = undefined; })
    );

    void this._pushSessions();
  }

  public dispose(): void {
    this._viewDisposables.forEach(d => d.dispose());
    this._viewDisposables = [];
    this._focusWatcher?.dispose();
    if (this._registryTimer) { clearInterval(this._registryTimer); }
    this._activity?.dispose();
    void removeWindowEntry(process.pid);
  }

  /**
   * Repaint both lists from the current state. For callers outside the panel — the pending-approval
   * watcher especially, so a prompt shows up on the tick it appears rather than at the next scan.
   */
  public refresh(): void {
    void this._pushSessions();
    if (this._historyOpen) { void this._pushHistory(); }
  }

  // Open a brand-new Claude conversation in the current window's editor.
  // `primaryEditor.open` with no sessionId creates a fresh panel in the active
  // editor column. We do NOT use `claude-vscode.newConversation` here: it only
  // notifies already-open Claude panels and is a no-op when none exist.
  private _openNewSession(): void {
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
  }

  /**
   * Bring a session to the front, wherever it lives — this window, another window on this
   * machine, or another machine entirely.
   *
   * Public so the Telegram remote control can offer "Focus in IDE" without reimplementing the
   * cross-window and cross-machine handshakes. It reuses exactly the path a panel click takes, so
   * the two cannot drift apart.
   */
  public async focusSession(sessionId: string, _source?: string): Promise<boolean> {
    const outcome = await this._tryFocusForeignWindow(sessionId);
    if (outcome === 'focused') { return true; }
    if (outcome === 'foreign-failed') { return false; }
    await this._openSessionLocal(sessionId);
    return true;
  }

  // Reveal a session in the current window, in the place it is ALREADY open.
  private async _openSessionLocal(sessionId: string): Promise<void> {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }

    if (session.source === 'bob') {
      void vscode.commands.executeCommand('bobChatView.focus');
      return;
    }

    if (session.source === 'codex') {
      void vscode.commands.executeCommand('workbench.view.extension.openai-chatgpt');
      return;
    }

    if (session.source === 'chat') {
      void vscode.commands.executeCommand('workbench.action.chat.open');
      return;
    }

    await this._openClaudeSessionLocal(sessionId);
  }

  /**
   * Focus a Claude session where it already lives, instead of opening a duplicate.
   *
   * `primaryEditor.open` is not a "focus" command — it calls Claude's `createPanel`,
   * which reveals an existing panel ONLY when `sessionPanels` holds the session id, and
   * otherwise creates a brand-new editor panel. A session living in the side bar is never
   * in `sessionPanels`, so calling it unconditionally spawned a second view of a session
   * that was already on screen. Hence the three-way split:
   *
   *  1. **Open as an editor panel** (`panels` holds the id) — `primaryEditor.open` is
   *     exactly right here: it reveals that panel in whatever editor group it sits in and
   *     creates nothing. This is also Claude's own definition of "open": it broadcasts
   *     `sessionPanels.keys()` to its UI as `openSessionIds`.
   *  2. **Held by this window but not an editor panel, while the user's Claude layout is
   *     the side bar** — then the side bar is where it is showing, so focus that.
   *     `claude-vscode.sidebar.open` is the extension's own entry point and picks
   *     `claudeVSCodeSidebarSecondary` or `claudeVSCodeSidebar` per host support.
   *  3. **Anything else** (a closed or older session, or panel layout) — open it by id,
   *     which reopens the conversation. Pre-existing behaviour, unchanged.
   *
   * Known limit: Claude exposes no per-session side bar API and does not track which
   * session the side bar is showing — `sessionStates` accumulates, and the side bar's
   * session-change reports are discarded by its manager. So in case 2 we can focus the
   * side bar but not force it to a specific session. That still beats opening a duplicate
   * panel, and it matches what Claude's own `editor.openLast` does.
   */
  private async _openClaudeSessionLocal(sessionId: string): Promise<void> {
    const state = await getOpenClaudeSessionIds(this._log);

    if (state.panels.includes(sessionId)) {
      this._log(`switch: ${sessionId} is an open editor panel — revealing it`);
      void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
      return;
    }

    if (state.states.includes(sessionId) && this._claudePrefersSidebar()) {
      this._log(`switch: ${sessionId} is held by this window in side bar layout — focusing the side bar`);
      void vscode.commands.executeCommand('claude-vscode.sidebar.open');
      return;
    }

    this._log(`switch: ${sessionId} has no open view here — opening it by id`);
    void vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  }

  /**
   * Whether Claude is configured to open conversations in the side bar.
   *
   * `claudeCode.preferredLocation` ('sidebar' | 'panel', default 'panel') is a normal
   * setting, so we read it directly — no inspector needed. Claude keeps it current on its
   * own: `sidebar.open` writes 'sidebar' and `editor.open` writes 'panel', so it tracks
   * where the user last opened Claude. We mirror Claude's own comparison, where anything
   * that is not exactly 'sidebar' means panel.
   */
  private _claudePrefersSidebar(): boolean {
    return vscode.workspace.getConfiguration('claudeCode').get<string>('preferredLocation') === 'sidebar';
  }

  // Returns labels of all currently open Claude Code or Bob editor tabs.
  // Uses duck-typing (not instanceof) so it works from both the local and
  // remote extension hosts.
  private _openClaudeTabLabels(): Set<string> {
    const labels = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[] } | undefined;
    if (!tabGroups) { return labels; }
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        // Duck-type: Claude Code panels have 'claudeVSCodePanel', Bob panels have 'bobChatView'
        const input = tab.input as { viewType?: string } | null | undefined;
        if (input?.viewType?.includes('claudeVSCodePanel') ||
            input?.viewType?.includes('bobChatView')) {
          labels.add(tab.label);
        }
      }
    }
    return labels;
  }

  private _sortedByRecency(): ClaudeSession[] {
    return [...this._sessionManager.getSessions()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /**
   * How long after its last interaction a window's open-tab report still counts. `0` disables it.
   *
   * Off by default. The signal it rests on cannot be checked from here: whether a remote extension
   * host that has lost its client really stops reporting itself active is a claim about the host,
   * not about this code, and getting it wrong hides sessions for a reason a user cannot see.
   */
  private _windowAttentionMs(): number {
    const minutes = vscode.workspace.getConfiguration('sessionSitter')
      .get<number>('windowAttentionMinutes', 0);
    const safe = typeof minutes === 'number' && minutes >= 0 ? minutes : 0;
    return safe * 60_000;
  }

  /** How long a probeless session (Codex / VS Code Chat) counts as active. */
  private _probelessWindowMs(): number {
    const minutes = vscode.workspace.getConfiguration('sessionSitter')
      .get<number>('probelessActiveWindowMinutes', DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES);
    const safe = typeof minutes === 'number' && minutes >= 0
      ? minutes : DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES;
    return safe * 60_000;
  }

  /**
   * Split sessions into the active worklist vs everything else (History).
   *
   * The rule itself lives in `sessionActivity.ts`, because Telegram shows the same worklist and a
   * second copy of this reasoning would drift the first time either changed. What stays here is
   * gathering the live signals the rule needs, all of which are panel-side:
   *
   *  - Bob reports its open task ids from the live `TaskManager`; Claude reports its open session
   *    ids from its manager. This window is read fresh and unioned with what other live windows
   *    published to the registry, so the answer is cross-window.
   *  - The probeless window comes from settings.
   *
   * The status each session is filtered and rendered by is the **display** status — the raw one
   * with a live pending approval folded in and `finished` split by whether you have read it. It is
   * resolved once, here, so the worklist, History, the row and Telegram all agree about a session.
   *
   * Both partitions stay sorted by recency.
   *
   * `current` is the session the panel marks as the one you are in. Claude's manager reports its
   * focused session id, so that is the answer for a Claude panel; no other source exposes such a
   * signal, which is why a focused Bob, Codex or Chat session leaves the list with no marked row
   * rather than a guessed one.
   */
  private async _partitionSessions(): Promise<{
    active: ClaudeSession[]; history: ClaudeSession[]; current: string | null;
  }> {
    const localClaude = await getOpenClaudeSessionIds(this._log);
    const localBobIds = await getOpenBobTaskIds(this._log);
    // `readLiveWindows` is local by construction: it reads this machine's registry directory and
    // tests liveness with `process.kill`, which cannot describe a pid on another host. Peer
    // windows arrive already filtered for liveness by the probe, on the machine that owns the pid.
    // Optional call: peer support is additive, and a session manager without it is still valid.
    const nowMs = Date.now();
    const attentionMs = this._windowAttentionMs();
    const windows = [
      ...await readLiveWindows(),
      ...(this._sessionManager.getPeerWindows?.() ?? []),
    // A window nobody has been at for a while no longer vouches for its tabs. `localClaude` and
    // `localBobIds` are exempt below: they are read live from THIS window's hosts, and this window
    // is by definition the one the user is in.
    ].filter(w => isAttendedWindow(w, attentionMs, nowMs));
    const all = this._sortedByRecency().map(s => this._withDisplayStatus(s));
    const { active, history } = partitionByActivity(all, {
      claudeOpenIds: new Set<string>([
        ...localClaude.open,
        ...windows.flatMap(w => w.openClaudeSessionIds ?? []),
      ]),
      bobOpenIds: new Set<string>([
        ...localBobIds,
        ...windows.flatMap(w => w.openBobTaskIds ?? []),
      ]),
      probelessWindowMs: this._probelessWindowMs(),
      nowMs,
    });
    return { active, history, current: localClaude.active };
  }

  /**
   * The worklist and History as the panel sees them, for a surface outside the panel.
   *
   * Telegram calls this rather than reading `SessionManager` directly, so its list *is* the
   * panel's list: same active rule, same display statuses, same order. Anything else and the two
   * views of one fleet disagree, which is the bug this exists to prevent.
   *
   * Briefly cached, because the computation runs the Bob and Claude probes and the Telegram loop
   * asks far more often than the panel repaints.
   */
  public async sessionPartition(): Promise<{
    active: ClaudeSession[]; history: ClaudeSession[]; current: string | null;
  }> {
    const now = Date.now();
    const cached = this._partitionCache;
    if (cached !== undefined && now - cached.at < PARTITION_CACHE_MS) { return cached.value; }
    const value = await this._partitionSessions();
    this._partitionCache = { at: now, value };
    return value;
  }

  /**
   * Fold the live signals into a session's status: a pending approval read from the agent's host,
   * and whether you have opened the session since it last changed.
   *
   * Done here rather than in the scan because both inputs are panel-side state — the pending map is
   * polled by the extension, the last-viewed stamps are written when you click a row — and because
   * doing it once, on the way out, is what keeps the worklist filter, the sort and the row from
   * disagreeing about what a session is.
   */
  private _withDisplayStatus(session: ClaudeSession): ClaudeSession {
    // Bob's rows are keyed by task id in the pending map; Claude's come from the hook trail. A
    // session appears in at most one, so looking up both is safe and needs no source branch here.
    const hookState = this._hookStates?.().get(session.sessionId);
    const status = resolveDisplayStatus(session.status, {
      pending: this._pendingBySession?.().get(session.sessionId),
      hookState,
      updatedAtMs: session.updatedAt.getTime(),
      lastViewedMs: this._lastViewed()[session.sessionId],
      nowMs: Date.now(),
    });
    // The tool a session is on is only worth showing while it is actually live: on a finished or
    // dormant row it is archaeology, and on a blocked row the status already says what is happening.
    const activeTool = hookState?.tool && (status === 'working' || status === 'stalled')
      ? hookState.tool
      : undefined;
    if (status === session.status && activeTool === session.activeTool) { return session; }
    return { ...session, status, activeTool };
  }

  /** When each session was last opened from the panel, by session id. */
  private _lastViewed(): Record<string, number> {
    return this._memento?.get<Record<string, number>>(LAST_VIEWED_KEY, {}) ?? {};
  }

  /**
   * Record that you have now looked at a session, so its finished result stops asking for you.
   *
   * Pruned to the sessions currently known, because the panel would otherwise accumulate a
   * timestamp per session opened for the lifetime of the install. A stamp dropped by the prune is
   * harmless: the row it belonged to is already gone from both lists.
   */
  private async _markViewed(sessionId: string): Promise<void> {
    if (!this._memento) { return; }
    const known = new Set(this._sessionManager.getSessions().map(s => s.sessionId));
    known.add(sessionId);
    const next: Record<string, number> = {};
    for (const [id, at] of Object.entries(this._lastViewed())) {
      if (known.has(id)) { next[id] = at; }
    }
    next[sessionId] = Date.now();
    try {
      await this._memento.update(LAST_VIEWED_KEY, next);
    } catch (err) {
      // Losing a read-marker is cosmetic — the row stays bold. Never let it break opening.
      this._log(`could not record last-viewed for ${sessionId}: ${String(err)}`);
    }
    await this._pushSessions();
    if (this._historyOpen) { await this._pushHistory(); }
  }

  /** The order the user picked for the session list. */
  private _sessionSort(): SessionSortMode {
    return toSessionSortMode(
      vscode.workspace.getConfiguration('sessionSitter')
        .get<string>('sessionSort', DEFAULT_SESSION_SORT));
  }

  /**
   * Prepare rows for display: cap first, then sort, then colour.
   *
   * The cap has to be applied to the recency-ordered list, before the display sort — sorting by
   * title and *then* taking the first 20 would silently drop the sessions you touched most
   * recently, which is the opposite of what a worklist is for.
   */
  private _forDisplay(sessions: ClaudeSession[], limit: number): SessionRow[] {
    const rules = vscode.workspace.getConfiguration('sessionSitter')
      .get<WorkspaceColorRules>('workspaceColors', {});
    return sortSessions(sessions.slice(0, limit), this._sessionSort()).map(session => {
      const workspaceColor = resolveWorkspaceColor(session, rules);
      // Absent, not null: an uncoloured pill must keep the theme's badge colour, and the webview
      // decides that by the field simply not being there.
      return workspaceColor ? { ...session, workspaceColor } : { ...session };
    });
  }

  private async _pushSessions(): Promise<void> {
    if (!this._view) { return; }
    const { active, current } = await this._partitionSessions();
    void this._view.webview.postMessage({
      type: 'updateSessions',
      sessions: this._forDisplay(active, SESSIONS_LIMIT),
      // Which row the panel marks as the session you are in. A panel whose whole job is switching
      // between sessions has to say which one you are looking at.
      currentSessionId: current,
      // Sent with the sessions so the panel can name peers it could not reach, rather than
      // letting an unreachable machine look like a machine with nothing running.
      // Optional call: peer support is additive, and a session manager without it is still valid.
      peers: this._sessionManager.getPeerStatuses?.() ?? [],
      // The sort menu is built from these, so the modes exist in exactly one place — here — and
      // the panel cannot offer an order the sorter does not implement.
      sortMode: this._sessionSort(),
      sortModes: SESSION_SORT_MODES,
    });
  }

  private async _pushHistory(): Promise<void> {
    if (!this._view) { return; }
    const { history } = await this._partitionSessions();
    void this._view.webview.postMessage({
      type: 'updateHistory', sessions: this._forDisplay(history, HISTORY_LIMIT),
    });
  }

  /**
   * Record the order the user picked from the panel's sort menu.
   *
   * Written to the global (user) settings so the choice survives a reload and applies in every
   * window — the session list is the same list everywhere, so a per-workspace answer would mean
   * the same rows sorted differently depending on which window you looked at them from.
   */
  private async _setSessionSort(mode: unknown): Promise<void> {
    const next = toSessionSortMode(mode);
    try {
      await vscode.workspace.getConfiguration('sessionSitter')
        .update('sessionSort', next, vscode.ConfigurationTarget.Global);
    } catch (err) {
      // A settings file that cannot be written (read-only, or managed by policy) would otherwise
      // leave the panel showing an order it did not actually adopt. Say so, and re-push either
      // way, so the list and the menu's check mark agree with what is really stored.
      void vscode.window.showWarningMessage(
        `Could not save the session order: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this._pushSessions();
    if (this._historyOpen) { await this._pushHistory(); }
  }

  // Close the Claude Code editor tab whose label matches the session's title.
  private _closeTabForSession(sessionId: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabGroups = (vscode.window as any).tabGroups as { all: readonly { tabs: readonly { input: unknown; label: string }[] }[]; close(tab: unknown): unknown } | undefined;
    if (!tabGroups) { return; }
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session) { return; }
    for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { viewType?: string } | null | undefined;
        if (input?.viewType?.includes('claudeVSCodePanel') && tab.label === session.title) {
          void tabGroups.close(tab);
          return;
        }
      }
    }
  }

  // Called when a focus-<pid>.json file is created/changed in the session-sitter dir.
  // Reads the request, checks freshness, calls primaryEditor.open, and deletes the file.
  async _handleFocusRequest(uri: { fsPath: string }): Promise<void> {
    try {
      const raw = await fs.promises.readFile(uri.fsPath, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: unknown; requestedAt?: unknown };
      if (typeof data.sessionId !== 'string' || typeof data.requestedAt !== 'number') { return; }
      if (Date.now() - data.requestedAt > 10_000) { return; }
      await this._openSessionLocal(data.sessionId);
    } catch { /* malformed or missing */ } finally {
      try { await fs.promises.unlink(uri.fsPath); } catch { /* already gone */ }
    }
  }

  // Watch for focus requests addressed to this window's PID and handle them.
  private _startFocusRequestWatcher(): vscode.Disposable {
    const dir = path.join(os.homedir(), '.claude', 'session-sitter');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(dir),
      `focus-${process.pid}.json`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(uri => { void this._handleFocusRequest(uri); });
    watcher.onDidChange(uri => { void this._handleFocusRequest(uri); });
    return watcher;
  }

  // Find the live registry entry for a different window whose workspace owns the
  // session's project. Returns null when the session belongs to this window (local)
  // or has no live owner.
  private async _findOwnerWindow(sessionId: string): Promise<WindowEntry | null> {
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (!session?.projectPath) { return null; }
    const windows = await readLiveWindows();
    return windows.find(w =>
      w.pid !== process.pid &&
      w.workspaceFolders.some(wf => session.projectPath === wf || session.projectPath.startsWith(wf + '/')),
    ) ?? null;
  }

  private async _tryFocusForeignWindow(sessionId: string): Promise<'focused' | 'foreign-failed' | 'local'> {
    // A session tagged with a peer lives on another machine, so the same two-step handshake has
    // to run over there. Checked first: no local window can own it.
    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    if (session?.peer) {
      return await this._sessionManager.focusRemoteSession(sessionId) ? 'focused' : 'foreign-failed';
    }

    const owner = await this._findOwnerWindow(sessionId);
    if (!owner) { return 'local'; }
    if (!owner.ipcSocket || !owner.ideCli) { return 'foreign-failed'; }

    try {
      const dir = path.join(os.homedir(), '.claude', 'session-sitter');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, `focus-${owner.pid}.json`),
        JSON.stringify({ sessionId, requestedAt: Date.now() }),
        'utf8',
      );

      await new Promise<void>((resolve, reject) => {
        execFile(
          owner.ideCli,
          ['--reuse-window', owner.workspaceFolders[0]],
          { env: { ...process.env, VSCODE_IPC_HOOK_CLI: owner.ipcSocket }, timeout: 3000 },
          err => { if (err) { reject(err); } else { resolve(); } },
        );
      });

      return 'focused';
    } catch {
      return 'foreign-failed';
    }
  }

  /** The corpus repo root the uploader writes into (`sessionSitter.dataRepoPath`). */
  private _corpusRepoRoot(): string {
    return (vscode.workspace.getConfiguration('sessionSitter')
      .get<string>('dataRepoPath') ?? '').trim();
  }

  /**
   * Upload one session to the corpus repository, in-process. This used to shell out to
   * `upload_session.py`; the uploader is TypeScript now, so there is no subprocess and no
   * Python involved.
   */
  private async _uploadSessionToCorpus(sessionId: string): Promise<void> {
    const repoRoot = this._corpusRepoRoot();
    if (!repoRoot || !fs.existsSync(repoRoot)) {
      void vscode.window.showErrorMessage(
        'Set `sessionSitter.dataRepoPath` to your corpus repository before uploading sessions.');
      return;
    }

    const exported = await this._sessionManager.exportSessionAsJson(sessionId);
    if (!exported) {
      void vscode.window.showErrorMessage('corpus: could not resolve session file.');
      return;
    }

    const session = this._sessionManager.getSessions().find(s => s.sessionId === sessionId);
    const source = session?.source ?? 'other';
    const slug = this._slugify(session?.title ?? sessionId);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Uploading session to the corpus…',
        cancellable: false,
      },
      async () => {
        try {
          const result = await uploadSession({
            repoRoot,
            sessionFile: exported.filePath,
            source,
            slug,
            log: msg => this._log(`[corpus upload] ${msg}`),
          });
          void vscode.window.showInformationMessage(
            `Session uploaded ✓ — ${result.storedName}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Upload failed — ${message}`);
        } finally {
          exported.cleanup();
        }
      },
    );
  }
  private _slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'session'
    );
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const mainScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'main.js')
    );
    const menuScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'toolbarMenu.js')
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles.css')
    );
    const nonce = getNonce();

    const buildDisplay = BUILD_TIME.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>Session Sitter</title>
</head>
<body>
  <div id="tab-bar">
    <div id="toolbar">
      <button id="menu-btn" title="Menu" aria-label="Session Sitter menu"
              aria-haspopup="menu" aria-expanded="false">&#x2630;</button>
      <button id="sort-btn" title="Sort sessions" aria-label="Sort sessions"
              aria-haspopup="menu" aria-expanded="false">&#x21C5;</button>
      <button id="new-session-btn" title="New Claude Session"
              aria-label="New Claude session">+</button>
      <button id="new-bob-session-btn" title="New Bob Session"
              aria-label="New Bob session">+B</button>
    </div>
    <div id="tab-strip" role="tablist" aria-label="Agent sessions"></div>
    <button id="history-toggle" aria-expanded="false">History &#x25B6;</button>
    <div id="history-panel" hidden></div>
    <button id="activity-toggle" aria-expanded="true">Supervision activity &#x25BC;</button>
    <div id="activity-panel" aria-live="polite"></div>
  </div>
  <div id="about-box" role="dialog" aria-modal="true" aria-labelledby="about-title" hidden>
    <div class="about-name" id="about-title">Session Sitter</div>
    <div class="about-version">v${BUILD_VERSION}</div>
    <div class="about-built">Built ${buildDisplay}</div>
    <button id="about-close">Close</button>
  </div>
  <div id="session-preview" hidden></div>
  <script nonce="${nonce}" src="${menuScriptUri}"></script>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>`;
  }
}
