import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── VS Code stub ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before variable declarations, so mock fns must
// be created with vi.hoisted() to be accessible inside the factory.
const {
  mockExecuteCommand,
  mockShowWarningMessage,
  mockGetConfiguration,
  mockOpenTextDocument,
  mockShowTextDocument,
  mockSetStatusBarMessage,
  mockShowInformationMessage,
  mockClipboardWriteText,
  mockOnDidChangeConfiguration,
} = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockGetConfiguration: vi.fn((): { get: (key?: string, fallback?: unknown) => unknown } => ({ get: () => 'panel' })),
  mockOpenTextDocument: vi.fn().mockResolvedValue({ uri: 'doc://untitled' }),
  mockShowTextDocument: vi.fn().mockResolvedValue(undefined),
  mockSetStatusBarMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  mockShowInformationMessage: vi.fn().mockResolvedValue(undefined),
  mockClipboardWriteText: vi.fn().mockResolvedValue(undefined),
  // The listener is typed as a parameter so a test can pull it back out of `.mock.calls`.
  mockOnDidChangeConfiguration: vi.fn((_listener: unknown) => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => {
  const EventEmitter = class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  };
  const FileSystemWatcher = class {
    onDidCreate = vi.fn();
    onDidChange = vi.fn();
    onDidDelete = vi.fn();
    dispose = vi.fn();
  };
  return {
    EventEmitter,
    // Claude picks its side bar view id from the VS Code version alone; 1.106+ has the
    // secondary side bar, which is the layout the side bar tests describe.
    version: '1.106.0',
    workspace: {
      createFileSystemWatcher: vi.fn(() => new FileSystemWatcher()),
      getConfiguration: mockGetConfiguration,
      workspaceFolders: [],
      openTextDocument: mockOpenTextDocument,
      // The panel repaints when a setting that shapes the list changes; the handler is captured
      // so a test can fire it.
      onDidChangeConfiguration: mockOnDidChangeConfiguration,
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window: {
      state: { active: true, focused: true },
      tabGroups: { all: [], onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
      showWarningMessage: mockShowWarningMessage,
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      showTextDocument: mockShowTextDocument,
      setStatusBarMessage: mockSetStatusBarMessage,
      showInformationMessage: mockShowInformationMessage,
    },
    env: {
      appName: 'IBM Bob',
      clipboard: { writeText: mockClipboardWriteText },
    },
    commands: { executeCommand: mockExecuteCommand },
    // The open-session probes reach the agents' extension hosts through vscode.extensions.
    // With none present they report nothing open, which is what these tests want.
    extensions: { getExtension: vi.fn(() => undefined), all: [] },
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => p }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath, ...parts].join('/'),
        toString: () => [base.fsPath, ...parts].join('/'),
      }),
    },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
  };
});

// ── os stub (homedir is non-configurable, must use vi.mock) ───────────────────
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn().mockReturnValue(actual.homedir()) };
});

// ── SessionManager stub ────────────────────────────────────────────────────────
vi.mock('../SessionManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionManager')>();
  return { ...actual, getActiveSessionIds: vi.fn().mockResolvedValue(new Set()) };
});

// ── WindowRegistry stub ──────────────────────────────────────────────────────
const { mockReadLiveWindows, mockWriteWindowEntry } = vi.hoisted(() => ({
  mockReadLiveWindows: vi.fn().mockResolvedValue([]),
  mockWriteWindowEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../WindowRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../WindowRegistry')>();
  return {
    ...actual,
    readLiveWindows: mockReadLiveWindows,
    writeWindowEntry: mockWriteWindowEntry,
    removeWindowEntry: vi.fn().mockResolvedValue(undefined),
    discoverOwnIpcSocket: vi.fn().mockReturnValue('/run/self.sock'),
    detectIdeCli: vi.fn().mockReturnValue('bobide'),
  };
});

// ── ClaudeInspector stub ─────────────────────────────────────────────────────
// The real probe reaches Claude's live extension host over the V8 inspector, which
// does not exist under test. Stubbing it lets us state exactly WHERE a session is
// open — as an editor panel, or held by the window with no panel (the side bar).
const { mockGetOpenClaudeSessionIds, mockRevealInSidebar } = vi.hoisted(() => ({
  mockGetOpenClaudeSessionIds: vi.fn(),
  mockRevealInSidebar: vi.fn(),
}));
vi.mock('../agents/ClaudeInspector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/ClaudeInspector')>();
  return {
    ...actual,
    getOpenClaudeSessionIds: mockGetOpenClaudeSessionIds,
    revealClaudeSessionInSidebar: mockRevealInSidebar,
  };
});

/** Point the stubbed probe at a given layout. Defaults to "this window holds nothing". */
function setClaudeOpenState(
  state: { panels?: string[]; states?: string[]; active?: string | null; sidebar?: boolean },
): void {
  const panels = state.panels ?? [];
  const states = state.states ?? [];
  mockGetOpenClaudeSessionIds.mockResolvedValue({
    open: [...new Set([...panels, ...states])],
    panels,
    states,
    active: state.active ?? null,
    // Whether Claude's side bar view is resolved in this window. Defaults to false, so a
    // test must say so explicitly to get the side bar branch.
    sidebar: state.sidebar ?? false,
  });
}

/** Set Claude's `claudeCode.preferredLocation` as the extension would read it. */
function setClaudePreferredLocation(location: 'sidebar' | 'panel'): void {
  mockGetConfiguration.mockImplementation((section?: string) => ({
    get: (key?: string, fallback?: unknown) => {
      if (section === 'claudeCode' && key === 'preferredLocation') { return location; }
      return fallback;
    },
  }));
}

// ── child_process stub ─────────────────────────────────────────────────────────
vi.mock('child_process', () => ({ execFile: vi.fn() }));

import * as vscode from 'vscode';
import { SessionSitterViewProvider, claudeSidebarViewId } from '../SessionSitterViewProvider';
import { SessionManager } from '../SessionManager';
import { execFile } from 'child_process';

// Set the Claude editor tabs the mocked tabGroups API reports as open.
function setOpenClaudeTabs(labels: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).tabGroups.all = [{
    tabs: labels.map(label => ({ input: { viewType: 'claudeVSCodePanel' }, label })),
  }];
}

/**
 * A stand-in for `context.globalState`, holding the last-viewed stamps in memory.
 *
 * Seed it to say "you already read this session at time T"; read it back to assert a click was
 * recorded. Without one the provider still works, it just cannot tell read from unread — which is
 * itself worth a test.
 */
function makeMemento(seed: Record<string, number> = {}) {
  let store: Record<string, number> = { ...seed };
  return {
    memento: {
      get: <T>(_key: string, fallback: T) => (store as unknown as T) ?? fallback,
      update: (_key: string, value: unknown) => {
        store = value as Record<string, number>;
        return Promise.resolve();
      },
      keys: () => ['sessionSitter.lastViewed'],
    } as unknown as import('vscode').Memento,
    read: () => store,
  };
}

function makeProvider(
  sessions: import('../SessionManager').ClaudeSession[] = [],
  extra: Partial<Record<string, unknown>> = {},
  opts: {
    memento?: import('vscode').Memento;
    pending?: ReadonlyMap<string, 'approval' | 'question'>;
  } = {},
) {
  const mockManager = {
    getSessions: vi.fn().mockReturnValue(sessions),
    onDidChangeSessions: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    dispose: vi.fn(),
    ...extra,
  } as unknown as SessionManager;
  return new SessionSitterViewProvider(
    { fsPath: '/fake' } as unknown as import('vscode').Uri,
    mockManager,
    undefined,
    undefined,
    opts.memento,
    opts.pending ? () => opts.pending! : undefined,
  );
}

// Every test starts from "this window holds no Claude session, panel layout", so the
// tests that care about location opt in explicitly and cannot leak into each other.
beforeEach(() => {
  setClaudeOpenState({});
  mockGetConfiguration.mockImplementation(() => ({ get: () => 'panel' }));
});

// ── Tests: _handleFocusRequest ────────────────────────────────────────────────
describe('_handleFocusRequest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'focus-recv-'));
    mockExecuteCommand.mockClear();
    mockShowWarningMessage.mockClear();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('triggers a local open for a fresh request', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now(),
    }));

    // Provide the session so _openSessionLocal can find it and dispatch
    const session = {
      sessionId: 'abc-123', projectPath: '/home/user/project', projectName: 'project',
      title: 'Test', updatedAt: new Date(), status: 'seen' as const, source: 'claude' as const,
    };
    const provider = makeProvider([session]);
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    // Routes through _openSessionLocal, which opens the session by id.
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'claude-vscode.primaryEditor.open', 'abc-123');
  });

  it('deletes the file after handling', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now(),
    }));

    const provider = makeProvider();
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    await expect(fs.promises.access(focusFile)).rejects.toThrow();
  });

  it('does not call primaryEditor.open for a stale request (>10s)', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, JSON.stringify({
      sessionId: 'abc-123',
      workspacePath: '/home/user/project',
      requestedAt: Date.now() - 15_000,
    }));

    const provider = makeProvider();
    await (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
      ._handleFocusRequest({ fsPath: focusFile });

    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('does not throw for malformed JSON (still deletes the file)', async () => {
    const focusFile = path.join(tmpDir, 'focus-req.json');
    await fs.promises.writeFile(focusFile, 'not json');

    const provider = makeProvider();
    await expect(
      (provider as unknown as { _handleFocusRequest(u: { fsPath: string }): Promise<void> })
        ._handleFocusRequest({ fsPath: focusFile })
    ).resolves.toBeUndefined();

    await expect(fs.promises.access(focusFile)).rejects.toThrow();
  });
});

// ── Tests: _findOwnerWindow & _tryFocusForeignWindow ──────────────────────────
type PrivateProvider = {
  _findOwnerWindow(id: string): Promise<unknown>;
  _tryFocusForeignWindow(id: string): Promise<'focused' | 'foreign-failed' | 'local'>;
};

function providerWithSession(projectPath: string): PrivateProvider {
  const session = {
    sessionId: 'S', projectPath, projectName: 'proj', title: 'S',
    updatedAt: new Date(), status: 'seen' as const, source: 'claude' as const,
  };
  return makeProvider([session]) as unknown as PrivateProvider;
}

describe('_findOwnerWindow', () => {
  beforeEach(() => {
    mockReadLiveWindows.mockReset();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
  });

  it('returns null when the only match is our own pid', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s', updatedAt: Date.now() },
    ]);
    expect(await providerWithSession('/ws/proj')._findOwnerWindow('S')).toBeNull();
  });

  it('returns a foreign window whose workspace contains the project', async () => {
    const owner = { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() };
    mockReadLiveWindows.mockResolvedValue([owner]);
    expect(await providerWithSession('/ws/proj')._findOwnerWindow('S')).toEqual(owner);
  });
});

describe('_tryFocusForeignWindow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'focus-send-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
    mockReadLiveWindows.mockReset();
    (execFile as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(async () => {
    vi.mocked(os.homedir).mockReset();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns "local" when no foreign owner', async () => {
    mockReadLiveWindows.mockResolvedValue([]);
    expect(await providerWithSession('/ws/proj')._tryFocusForeignWindow('S')).toBe('local');
  });

  it('returns "foreign-failed" when owner has no ipcSocket', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now() },
    ]);
    expect(await providerWithSession('/ws/proj')._tryFocusForeignWindow('S')).toBe('foreign-failed');
  });

  it('execs the owner CLI with its socket and returns "focused"', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => cb(null),
    );
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() },
    ]);
    const result = await providerWithSession('/ws/proj')._tryFocusForeignWindow('S');
    expect(result).toBe('focused');
    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('bobide');
    expect(call[1]).toEqual(['--reuse-window', '/ws']);
    expect(call[2].env.VSCODE_IPC_HOOK_CLI).toBe('/s.sock');
  });

  it('returns "foreign-failed" when execFile throws', async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => cb(new Error('ENOENT')),
    );
    mockReadLiveWindows.mockResolvedValue([
      { pid: process.pid + 1, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: Date.now() },
    ]);
    expect(await providerWithSession('/ws/proj')._tryFocusForeignWindow('S')).toBe('foreign-failed');
  });
});

// ── Tests: _openSessionLocal ──────────────────────────────────────────────────
describe('_openSessionLocal', () => {
  const session = {
    sessionId: 'sess-1', projectPath: '/p', projectName: 'p', title: 'My Session',
    updatedAt: new Date(), status: 'seen' as const, source: 'claude' as const,
  };

  type Openable = { _openSessionLocal(id: string): Promise<void> };

  beforeEach(() => {
    mockExecuteCommand.mockClear();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
    setOpenClaudeTabs([]);
    setClaudeOpenState({});
    setClaudePreferredLocation('panel');
    mockRevealInSidebar.mockReset();
    mockRevealInSidebar.mockResolvedValue('revealed');
  });
  afterEach(() => {
    setOpenClaudeTabs([]);
    mockGetConfiguration.mockImplementation(() => ({ get: () => 'panel' }));
  });

  it('reveals the existing editor panel when the session is open as one', async () => {
    // `primaryEditor.open` with an id that IS in Claude's sessionPanels reveals that
    // panel in place — createPanel returns early and creates nothing.
    setClaudeOpenState({ panels: ['sess-1'], states: ['sess-1'] });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });

  it('reveals a side bar session there even though preferredLocation says panel', async () => {
    // The reported bug, and the regression guard for its cause. The session is live in the
    // secondary side bar — held by the window, absent from sessionPanels — but the setting
    // reads 'panel', because only `claude-vscode.sidebar.open` writes 'sidebar' and the
    // user revealed the view from VS Code's own UI. Gating on the setting sent this to
    // `primaryEditor.open`, which duplicated an on-screen session into the main editor.
    // The window's own `sidebar` fact must decide instead.
    setClaudeOpenState({ panels: [], states: ['sess-1'], sidebar: true });
    setClaudePreferredLocation('panel');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockRevealInSidebar).toHaveBeenCalledWith('sess-1', expect.any(Function));
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });

  it('aims the side bar at the session instead of only focusing the side bar', async () => {
    // `sidebar.open` focused the side bar without saying which session, so it showed
    // whatever it already had. The reveal goes through Claude's `activateInSidebar`, so
    // the id must reach it — and `sidebar.open` must not be used, since it also rewrites
    // the user's preferredLocation setting as a side effect.
    setClaudeOpenState({ panels: [], states: ['sess-1'], sidebar: true });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockRevealInSidebar).toHaveBeenCalledWith('sess-1', expect.any(Function));
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
  });

  it('focuses the side bar view by id when the reveal could not bring it forward', async () => {
    // The manager took the session but we could not reach its view object. Fall back to
    // the view id rather than opening a duplicate panel.
    setClaudeOpenState({ panels: [], states: ['sess-1'], sidebar: true });
    mockRevealInSidebar.mockResolvedValue('activated');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claudeVSCodeSidebarSecondary.focus');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });

  it('opens by id when the side bar refuses the session', async () => {
    // No live side bar to receive the activation after all. Degrade to the old behaviour
    // rather than leaving the click doing nothing.
    setClaudeOpenState({ panels: [], states: ['sess-1'], sidebar: true });
    mockRevealInSidebar.mockResolvedValue('unavailable');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });

  it('prefers the editor panel over the side bar when the session has both', async () => {
    // A panel is an unambiguous, per-session target. Panel wins.
    setClaudeOpenState({ panels: ['sess-1'], states: ['sess-1'], sidebar: true });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockRevealInSidebar).not.toHaveBeenCalled();
  });

  it('opens by id when no side bar view exists, whatever preferredLocation claims', async () => {
    // The mirror of the bug: the setting says 'sidebar' but no side bar view is resolved,
    // so there is nothing to reveal and aiming at one would focus an empty container.
    setClaudeOpenState({ panels: [], states: ['sess-1'], sidebar: false });
    setClaudePreferredLocation('sidebar');
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockRevealInSidebar).not.toHaveBeenCalled();
  });

  it('opens a closed session by id rather than aiming at the side bar', async () => {
    // Not in panels and not held by this window at all: nothing to reveal, even with a
    // live side bar. Reopen by id.
    setClaudeOpenState({ panels: [], states: [], sidebar: true });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
    expect(mockRevealInSidebar).not.toHaveBeenCalled();
  });

  it('falls back to opening by id when the probe cannot reach Claude', async () => {
    // Probe failure reports an empty state. Degrade to the old behaviour rather than
    // silently doing nothing.
    mockGetOpenClaudeSessionIds.mockResolvedValue({
      open: [], panels: [], states: [], active: null, diag: 'gB-not-found',
    });
    const p = makeProvider([session]) as unknown as Openable;
    await p._openSessionLocal('sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'sess-1');
  });
});

// ── Tests: _openNewSession ────────────────────────────────────────────────────
describe('_openNewSession', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  it('opens a fresh conversation in the current window editor', () => {
    const p = makeProvider() as unknown as { _openNewSession(): void };
    p._openNewSession();
    // primaryEditor.open with no sessionId creates a new conversation panel in
    // the active editor column — unlike newConversation, which only notifies
    // already-open panels and is a no-op when none exist.
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open');
  });
});

// ── Helpers for Bob sessions ──────────────────────────────────────────────────

function makeBobSession(overrides: Partial<import('../SessionManager').ClaudeSession> = {}): import('../SessionManager').ClaudeSession {
  return {
    sessionId: 'bob-sess-1',
    projectPath: '/home/user/proj',
    projectName: 'proj',
    title: 'My Bob Task',
    updatedAt: new Date(),
    status: 'seen' as const,
    source: 'bob' as const,
    ...overrides,
  };
}

function setOpenBobTabs(labels: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).tabGroups.all = [{
    tabs: labels.map(label => ({ input: { viewType: 'bobChatView' }, label })),
  }];
}

// ── Tests: Bob session switching ──────────────────────────────────────────────
describe('_openSessionLocal (Bob)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockClear();
    vi.mocked(os.homedir).mockReturnValue(os.tmpdir());
    setOpenBobTabs([]);
  });
  afterEach(() => { setOpenBobTabs([]); });

  it('calls bobChatView.focus for a Bob session', () => {
    const p = makeProvider([makeBobSession()]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('bob-sess-1');
    expect(mockExecuteCommand).toHaveBeenCalledWith('bobChatView.focus');
  });

  it('does NOT call claude-vscode commands for a Bob session', () => {
    const p = makeProvider([makeBobSession()]) as unknown as { _openSessionLocal(id: string): void };
    p._openSessionLocal('bob-sess-1');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.sidebar.open');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', expect.anything());
  });
});

// ── Tests: newBobSession ──────────────────────────────────────────────────────
describe('webview message: newBobSession', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  function resolveWebview(provider: import('../SessionSitterViewProvider').SessionSitterViewProvider) {
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(),
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    const webviewView = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
    };
    provider.resolveWebviewView(
      webviewView as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    return (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
  }

  it('calls bob-code.task.pickWorkspace', async () => {
    const handler = resolveWebview(makeProvider());
    await handler({ type: 'newBobSession' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('bob-code.task.pickWorkspace');
  });
});

// ── Tests: addFromHistory (Bob) ───────────────────────────────────────────────
describe('webview message: addFromHistory (Bob)', () => {
  beforeEach(() => { mockExecuteCommand.mockClear(); });

  function resolveWebview(provider: import('../SessionSitterViewProvider').SessionSitterViewProvider) {
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(),
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    const webviewView = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
    };
    provider.resolveWebviewView(
      webviewView as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    return (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
  }

  it('calls bobChatView.focus for a Bob history session', async () => {
    const bobSession = makeBobSession({ sessionId: 'bob-hist-1' });
    const handler = resolveWebview(makeProvider([bobSession]));
    await handler({ type: 'addFromHistory', sessionId: 'bob-hist-1' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('bobChatView.focus');
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('claude-vscode.primaryEditor.open', expect.anything());
  });

  it('calls claude-vscode.primaryEditor.open for a Claude history session', async () => {
    const claudeSession = {
      sessionId: 'claude-hist-1', projectPath: '/p', projectName: 'p',
      title: 'Claude task', updatedAt: new Date(), status: 'seen' as const, source: 'claude' as const,
    };
    const handler = resolveWebview(makeProvider([claudeSession]));
    await handler({ type: 'addFromHistory', sessionId: 'claude-hist-1' });
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-vscode.primaryEditor.open', 'claude-hist-1');
  });
});

// ── Tests: latest-sessions-by-activity view (_pushSessions / _pushHistory) ────
// The Sessions view is a live worklist, not a recency slice: only sessions the user can act on
// right now. Bob/Claude are judged by what their extension hosts report as open (unioned across
// windows) plus a not-idle status; Codex and VS Code Chat have no such signal, so they fall back
// to a recency window. Everything else is History.
describe('Sessions view: active-vs-history partition', () => {
  function resolveWebviewCapturing(provider: import('../SessionSitterViewProvider').SessionSitterViewProvider) {
    const postMessage = vi.fn();
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage,
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    const webviewView = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
    };
    provider.resolveWebviewView(
      webviewView as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    return postMessage;
  }

  function makeSession(
    sessionId: string,
    minutesAgo: number,
    source: 'claude' | 'bob' | 'codex' | 'chat' = 'claude',
    status: import('../sessionStatus').SessionStatus = 'seen',
  ): import('../SessionManager').ClaudeSession {
    return {
      sessionId,
      projectPath: '/p',
      projectName: 'p',
      title: `t-${sessionId}`,
      updatedAt: new Date(Date.now() - minutesAgo * 60 * 1000),
      status,
      source,
    };
  }

  function capture(postMessage: ReturnType<typeof vi.fn>, type: 'updateSessions' | 'updateHistory') {
    return postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions: import('../SessionManager').ClaudeSession[] })
      .find(m => m.type === type);
  }

  beforeEach(() => {
    // Each push partitions independently, so the registry is read more than once per test.
    mockReadLiveWindows.mockResolvedValue([]);
  });

  it('keeps a Bob task the IDE reports open, and files the rest under History', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: 42, workspaceFolders: [], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now(),
        openBobTaskIds: ['b-open'] },
    ]);
    const all = [
      makeSession('b-open', 90, 'bob'),
      makeSession('b-closed', 1, 'bob'),
    ];
    const provider = makeProvider(all);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    // Recency does NOT decide membership: the older-but-open task is the active one.
    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId)).toEqual(['b-open']);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId)).toEqual(['b-closed']);
  });

  it('unions open ids across windows so another window\'s session still counts', async () => {
    mockReadLiveWindows.mockResolvedValue([
      { pid: 1, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-elsewhere'] },
    ]);
    const provider = makeProvider([makeSession('c-elsewhere', 30, 'claude')]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-elsewhere']);
  });

  it('treats a working session as active even when no probe reports it open', async () => {
    // Fallback for a WSL2 / inspector hiccup: a task that is running must not vanish into History
    // just because the live probe was momentarily silent.
    const provider = makeProvider([
      makeSession('b-running', 60, 'bob', 'working'),
      makeSession('b-idle', 5, 'bob', 'seen'),
    ]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['b-running']);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['b-idle']);
  });

  it('ages a stale working session into History', async () => {
    // The fallback covers a momentary probe hiccup, not a session abandoned weeks ago. A
    // month-old transcript has no live process behind it whatever its inferred status says.
    const provider = makeProvider([
      makeSession('c-stale-waiting', 60 * 24 * 29, 'claude', 'working'),
      makeSession('c-stale-active', 60 * 24 * 3, 'claude', 'working'),
    ]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions).toHaveLength(0);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['c-stale-active', 'c-stale-waiting']);
  });

  it('keeps a stale session active when a probe still reports it open', async () => {
    // The age bound only gates the fallback. A live report is authoritative at any age.
    mockReadLiveWindows.mockResolvedValue([
      { pid: 3, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-old-but-open'] },
    ]);
    const provider = makeProvider([makeSession('c-old-but-open', 60 * 24 * 29, 'claude', 'working')]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-old-but-open']);
  });

  it('keeps recent Codex/Chat sessions active and ages older ones into History', async () => {
    // Neither source exposes a liveness signal, so the recency window is the rule.
    const provider = makeProvider([
      makeSession('codex-fresh', 10, 'codex'),
      makeSession('chat-fresh', 20, 'chat'),
      makeSession('codex-stale', 60 * 5, 'codex'),
      makeSession('chat-stale', 60 * 9, 'chat'),
    ]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['codex-fresh', 'chat-fresh']);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['codex-stale', 'chat-stale']);
  });

  it('honors probelessActiveWindowMinutes = 0 by parking Codex/Chat in History', async () => {
    mockGetConfiguration.mockImplementation(() => ({ get: () => 0 }));
    try {
      const provider = makeProvider([makeSession('codex-fresh', 1, 'codex')]);
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
      await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

      expect(capture(postMessage, 'updateSessions')?.sessions).toHaveLength(0);
      expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
        .toEqual(['codex-fresh']);
    } finally {
      mockGetConfiguration.mockImplementation(() => ({ get: () => 'panel' }));
    }
  });

  it('sorts each partition by recency and caps them', async () => {
    // 30 open Bob tasks + 60 closed ones: Sessions caps at 20, History at 50, both newest first.
    const openIds = Array.from({ length: 30 }, (_, i) => `open-${i}`);
    mockReadLiveWindows.mockResolvedValue([
      { pid: 7, workspaceFolders: [], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now(),
        openBobTaskIds: openIds },
    ]);
    const all = [
      ...openIds.map((id, i) => makeSession(id, 30 - i, 'bob')),
      ...Array.from({ length: 60 }, (_, i) => makeSession(`closed-${i}`, 1000 - i, 'bob')),
    ];
    const provider = makeProvider(all);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    const sessions = capture(postMessage, 'updateSessions')?.sessions ?? [];
    expect(sessions).toHaveLength(20);
    expect(sessions.map(s => s.sessionId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `open-${29 - i}`));
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].updatedAt.getTime()).toBeGreaterThanOrEqual(
        sessions[i].updatedAt.getTime());
    }
  });

  it('caps History at 50 newest', async () => {
    const all = Array.from({ length: 75 }, (_, i) => makeSession(`s${i}`, 1000 - i, 'bob'));
    const provider = makeProvider(all);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    const sessions = capture(postMessage, 'updateHistory')?.sessions ?? [];
    expect(sessions).toHaveLength(50);
    expect(sessions[0].sessionId).toBe('s74'); // newest of the inactive set
  });

  // ── Peer windows count as live reporters ───────────────────────────────────
  //
  // `readLiveWindows` only ever sees this machine's registry, and its liveness test is
  // `process.kill`, which cannot say anything about a pid on another host. So a peer's session
  // could never be "reported open" and fell back to the status check — which an idle session at a
  // prompt fails. The result was a peer session that was pulled correctly and then filed under
  // History, looking to the user exactly like a session that was never found at all.
  //
  // The probe already resolves liveness on the owning machine (`kill -0` there, 24 h staleness),
  // so a peer window entry is as authoritative about its own machine as a local one is about this
  // one, and the two sets simply union.

  function peerSession(
    sessionId: string, minutesAgo: number, source: 'claude' | 'bob' = 'claude',
  ): import('../SessionManager').ClaudeSession {
    return { ...makeSession(sessionId, minutesAgo, source, 'seen'), peer: 'vpcuser@olap.ibm.com' };
  }

  it('keeps an idle peer session active when the peer window reports it open', async () => {
    const provider = makeProvider([peerSession('c-remote', 45)], {
      getPeerWindows: () => [{
        pid: 2881165, workspaceFolders: ['/home/vpcuser/proj'], ideCli: 'bobide',
        ipcSocket: '/run/user/1000/x.sock', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-remote'],
      }],
    });
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-remote']);
  });

  it('keeps an idle peer Bob task active when the peer window reports it open', async () => {
    const provider = makeProvider([peerSession('b-remote', 45, 'bob')], {
      getPeerWindows: () => [{
        pid: 99, workspaceFolders: ['/home/vpcuser/proj'], ideCli: 'bobide',
        ipcSocket: '', updatedAt: Date.now(), openBobTaskIds: ['b-remote'],
      }],
    });
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['b-remote']);
  });

  it('still files a peer session no peer window reports under History', async () => {
    // Union, not blanket promotion: a closed session on a peer is still history.
    const provider = makeProvider([peerSession('c-closed', 45)], {
      getPeerWindows: () => [{
        pid: 1, workspaceFolders: ['/home/vpcuser/proj'], ideCli: 'bobide',
        ipcSocket: '', updatedAt: Date.now(), openClaudeSessionIds: ['c-other'],
      }],
    });
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    expect(capture(postMessage, 'updateSessions')?.sessions ?? []).toEqual([]);
    expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
      .toEqual(['c-closed']);
  });

  it('partitions normally for a manager with no peer support at all', async () => {
    // `getPeerWindows` is additive; a manager without it must behave exactly as before.
    mockReadLiveWindows.mockResolvedValue([
      { pid: 1, workspaceFolders: [], ideCli: 'code', ipcSocket: '', updatedAt: Date.now(),
        openClaudeSessionIds: ['c-local'] },
    ]);
    const provider = makeProvider([makeSession('c-local', 30, 'claude')]);
    const postMessage = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['c-local']);
  });
  // ── Tests: the display status ─────────────────────────────────────────────────
  //
  // The row's status is not simply what the scan inferred. Two panel-side signals fold into it: a
  // live pending approval read from Bob's host, and whether you have opened the session since it last
  // changed. Both are resolved once, in the provider, so the worklist filter, the sort and the row
  // can never disagree about a session — and the asymmetry matters: a live signal may UPGRADE a
  // status, never downgrade one, because the probe can only see its own window.
  describe('display status', () => {
    function statusOf(
      postMessage: ReturnType<typeof vi.fn>,
      id: string,
      type: 'updateSessions' | 'updateHistory' = 'updateSessions',
    ) {
      return capture(postMessage, type)?.sessions.find(s => s.sessionId === id)?.status;
    }

    it('a live pending approval marks a working session as blocked on you', async () => {
      const provider = makeProvider(
        [makeSession('b-1', 1, 'bob', 'working')],
        {},
        { pending: new Map([['b-1', 'approval' as const]]) },
      );
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

      expect(statusOf(postMessage, 'b-1')).toBe('approval');
    });

    it('a live pending question is distinguished from an approval', async () => {
      const provider = makeProvider(
        [makeSession('b-1', 1, 'bob', 'working')],
        {},
        { pending: new Map([['b-1', 'question' as const]]) },
      );
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

      expect(statusOf(postMessage, 'b-1')).toBe('question');
    });

    it('an empty pending map never downgrades an inferred blocked state', async () => {
      // The probe only sees its own window, so "no pending reported" routinely means "open in
      // another window". Treating that silence as proof would turn every cross-window approval
      // prompt grey, which is the failure this design exists to fix.
      const provider = makeProvider(
        [makeSession('c-1', 1, 'claude', 'approval')],
        {},
        { pending: new Map() },
      );
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

      expect(statusOf(postMessage, 'c-1')).toBe('approval');
    });

    it('a finished session you have already opened shows as seen', async () => {
      const { memento } = makeMemento({ 'c-1': Date.now() });
      const provider = makeProvider(
        [makeSession('c-1', 5, 'claude', 'finished')], {}, { memento });
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

      expect(statusOf(postMessage, 'c-1', 'updateHistory')).toBe('seen');
    });

    it('a finished session changed since you last looked stays unread', async () => {
      const { memento } = makeMemento({ 'c-1': Date.now() - 60 * 60_000 });
      const provider = makeProvider(
        [makeSession('c-1', 5, 'claude', 'finished')], {}, { memento });
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

      expect(statusOf(postMessage, 'c-1', 'updateHistory')).toBe('finished');
    });

    it('with no memento a finished session simply stays unread', async () => {
      // Read-tracking is optional decoration. Without it the panel must still work, erring towards
      // "you have not seen this" rather than silently marking everything read.
      const provider = makeProvider([makeSession('c-1', 5, 'claude', 'finished')]);
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

      expect(statusOf(postMessage, 'c-1', 'updateHistory')).toBe('finished');
    });

    it('opening a session records that you have read it', async () => {
      const { memento, read } = makeMemento();
      const provider = makeProvider(
        [makeSession('c-1', 5, 'claude', 'finished')], {}, { memento });
      resolveWebviewCapturing(provider);
      await (provider as unknown as {
        _markViewed(id: string): Promise<void>;
      })._markViewed('c-1');

      expect(read()['c-1']).toBeGreaterThan(0);
    });

    it('forgets stamps for sessions that no longer exist', async () => {
      // Otherwise the panel accumulates one timestamp per session ever opened, for the life of the
      // install. A dropped stamp is harmless: its row is gone from both lists.
      const { memento, read } = makeMemento({ 'long-gone': 1_000 });
      const provider = makeProvider(
        [makeSession('c-1', 5, 'claude', 'finished')], {}, { memento });
      resolveWebviewCapturing(provider);
      await (provider as unknown as {
        _markViewed(id: string): Promise<void>;
      })._markViewed('c-1');

      expect(read()['long-gone']).toBeUndefined();
      expect(read()['c-1']).toBeGreaterThan(0);
    });
  });

  // ── Tests: blocked sessions never age out ────────────────────────────────────
  describe('worklist: blocked on you', () => {
    it('keeps a month-old session waiting for approval in the worklist', async () => {
      // A session blocked on your approval is stuck, not stale. The age bound exists to drop
      // abandoned mid-turn transcripts; applying it here would hide the one row you must act on.
      const provider = makeProvider([makeSession('c-blocked', 60 * 24 * 29, 'claude', 'approval')]);
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

      expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
        .toEqual(['c-blocked']);
    });

    it('keeps an old unanswered question in the worklist too', async () => {
      const provider = makeProvider([makeSession('c-asked', 60 * 24 * 5, 'claude', 'question')]);
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

      expect(capture(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
        .toEqual(['c-asked']);
    });

    it('files a finished session under History — it is a result, not a live session', async () => {
      const provider = makeProvider([makeSession('c-done', 5, 'claude', 'finished')]);
      const postMessage = resolveWebviewCapturing(provider);
      await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();
      await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

      expect(capture(postMessage, 'updateSessions')?.sessions).toHaveLength(0);
      expect(capture(postMessage, 'updateHistory')?.sessions.map(s => s.sessionId))
        .toEqual(['c-done']);
    });
  });

});

// ── Tests: copy transcript handlers ──────────────────────────────────────────
describe('webview message: copy transcript handlers', () => {
  beforeEach(() => {
    mockOpenTextDocument.mockClear();
    mockShowTextDocument.mockClear();
    mockClipboardWriteText.mockClear();
    mockSetStatusBarMessage.mockClear();
    mockShowInformationMessage.mockClear();
    mockShowWarningMessage.mockClear();
    mockExecuteCommand.mockClear();
  });

  function resolveWebview(provider: SessionSitterViewProvider) {
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(),
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    const webviewView = {
      webview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
    };
    provider.resolveWebviewView(
      webviewView as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    return (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
  }

  it('copyTranscriptToEditor opens an untitled markdown document with the transcript', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue('# transcript\n\nbody'),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToEditor', sessionId: 'sess-1' });
    await vi.waitFor(() => expect(mockShowTextDocument).toHaveBeenCalled(), { timeout: 2000 });
    expect(mockOpenTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: '# transcript\n\nbody' });
  });

  it('copyTranscriptToClipboard writes to env.clipboard and shows a status message', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue('some transcript'),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToClipboard', sessionId: 'sess-1' });
    await vi.waitFor(() => expect(mockSetStatusBarMessage).toHaveBeenCalled(), { timeout: 2000 });
    expect(mockClipboardWriteText).toHaveBeenCalledWith('some transcript');
  });

  it('copyTranscriptToFile writes to os.tmpdir() and offers Reveal in Finder', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue('# on disk'),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToFile', sessionId: 'sess-1' });

    // Handler is fire-and-forget; poll until showInformationMessage lands
    // (the IIFE has to `await exportFullTranscript` then `await fs.writeFile`).
    await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalled(), { timeout: 2000 });

    const call = mockShowInformationMessage.mock.calls[0];
    expect(call[0]).toMatch(/Transcript saved/);
    expect(call).toContain('Reveal in Finder');

    const tmpPath = (call[0] as string).match(/\/[^\s]+\.md/)?.[0];
    expect(tmpPath).toBeTruthy();
    const content = await fs.promises.readFile(tmpPath!, 'utf8');
    expect(content).toBe('# on disk');
    await fs.promises.unlink(tmpPath!);
  });

  it('shows a warning toast when exportFullTranscript returns null (session gone)', async () => {
    const provider = makeProvider([], {
      exportFullTranscript: vi.fn().mockResolvedValue(null),
    });
    const handler = resolveWebview(provider);
    await handler({ type: 'copyTranscriptToEditor', sessionId: 'gone' });
    await vi.waitFor(() => expect(mockShowWarningMessage).toHaveBeenCalled(), { timeout: 2000 });
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });
});


// ── Tests: session order and workspace colours ───────────────────────────────
//
// Both features are settings the panel reads on every push, so what matters here is the wiring:
// the rows the webview receives are ordered by the chosen mode, decorated with the colour the
// setting asks for, and — the one non-obvious part — capped by RECENCY before being re-sorted, so
// choosing an alphabetical order can never hide the sessions you just touched.
describe('session order and workspace colours', () => {
  function resolveWebviewCapturing(provider: SessionSitterViewProvider) {
    const postMessage = vi.fn();
    const webview = {
      options: {},
      html: '',
      onDidReceiveMessage: vi.fn(),
      postMessage,
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview:',
    };
    provider.resolveWebviewView(
      { webview, onDidDispose: vi.fn(() => ({ dispose: vi.fn() })), visible: true } as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    const handler = (webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as (msg: unknown) => Promise<void>;
    return { postMessage, handler };
  }

  interface PushedSessions {
    type: string;
    sessions: Array<import('../SessionManager').ClaudeSession & {
      workspaceColor?: { background: string; foreground: string };
    }>;
    sortMode?: string;
    sortModes?: Array<{ id: string; label: string }>;
    currentSessionId?: string | null;
  }

  /** The LAST message of a type, so a re-push after a settings change is what gets asserted. */
  function lastPush(postMessage: ReturnType<typeof vi.fn>, type: string): PushedSessions | undefined {
    const all = postMessage.mock.calls.map(c => c[0] as PushedSessions).filter(m => m.type === type);
    return all[all.length - 1];
  }

  /** Recent + non-idle, which is what keeps a Claude session in the active partition. */
  function activeSession(
    sessionId: string,
    over: Partial<import('../SessionManager').ClaudeSession> = {},
  ): import('../SessionManager').ClaudeSession {
    return {
      sessionId,
      projectPath: '/home/me/work/alpha',
      projectName: 'alpha',
      title: `t-${sessionId}`,
      updatedAt: new Date(Date.now() - 60_000),
      status: 'working',
      source: 'claude',
      ...over,
    };
  }

  /** Point `getConfiguration` at a plain map of settings, with `update` recorded. */
  function withSettings(values: Record<string, unknown>) {
    const update = vi.fn().mockResolvedValue(undefined);
    mockGetConfiguration.mockImplementation(() => ({
      get: (key?: string, fallback?: unknown) =>
        (key !== undefined && key in values ? values[key] : fallback),
      update,
    } as unknown as { get: (key?: string, fallback?: unknown) => unknown }));
    return update;
  }

  beforeEach(() => {
    mockReadLiveWindows.mockResolvedValue([]);
  });

  it('tells the panel which order is active, and every order it may offer', async () => {
    withSettings({ sessionSort: 'title' });
    const provider = makeProvider([activeSession('s1')]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    const pushed = lastPush(postMessage, 'updateSessions');
    expect(pushed?.sortMode).toBe('title');
    // The menu is built from this list, so it must arrive and must contain the default.
    expect(pushed?.sortModes?.map(m => m.id)).toContain('recent');
    expect(pushed?.sortModes?.length).toBeGreaterThan(1);
  });

  it('falls back to recency when the setting holds something unknown', async () => {
    withSettings({ sessionSort: 'sideways' });
    const provider = makeProvider([activeSession('s1')]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(lastPush(postMessage, 'updateSessions')?.sortMode).toBe('recent');
  });

  it('orders the pushed rows by the chosen mode, not by recency', async () => {
    withSettings({ sessionSort: 'title' });
    const provider = makeProvider([
      activeSession('newest', { title: 'zebra', updatedAt: new Date() }),
      activeSession('oldest', { title: 'apple', updatedAt: new Date(Date.now() - 600_000) }),
    ]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(lastPush(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId))
      .toEqual(['oldest', 'newest']);
  });

  it('caps by recency before sorting, so an alphabetical order cannot hide recent sessions', async () => {
    withSettings({ sessionSort: 'title' });
    // 21 sessions — one more than the list holds. The newest sorts LAST alphabetically, so a
    // cap applied after the sort would be exactly the bug that drops it.
    const all = Array.from({ length: 21 }, (_, i) => activeSession(`s${String(i).padStart(2, '0')}`, {
      title: String.fromCharCode('z'.charCodeAt(0) - i),
      updatedAt: new Date(Date.now() - i * 60_000),
    }));
    const provider = makeProvider(all);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    const ids = lastPush(postMessage, 'updateSessions')?.sessions.map(s => s.sessionId) ?? [];
    expect(ids).toHaveLength(20);
    expect(ids).toContain('s00');     // newest, alphabetically last — kept
    expect(ids).not.toContain('s20'); // oldest — the one the cap drops
  });

  it('colours a workspace the setting names, and leaves the others alone', async () => {
    withSettings({ workspaceColors: { alpha: 'green' } });
    const provider = makeProvider([
      activeSession('in-alpha'),
      activeSession('in-beta', { projectName: 'beta', projectPath: '/home/me/work/beta' }),
    ]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    const rows = lastPush(postMessage, 'updateSessions')?.sessions ?? [];
    const alpha = rows.find(s => s.sessionId === 'in-alpha');
    const beta = rows.find(s => s.sessionId === 'in-beta');
    expect(alpha?.workspaceColor?.background).toBe('#2e7d32');
    // A readable label colour travels with the fill, or the pill is unreadable on some themes.
    expect(alpha?.workspaceColor?.foreground).toBe('#ffffff');
    // Absent, not null: that is what leaves the pill on the theme's badge colour.
    expect(beta?.workspaceColor).toBeUndefined();
  });

  it('colours History rows too, and sorts them the same way', async () => {
    withSettings({ sessionSort: 'title', workspaceColors: { '*': 'blue' } });
    const provider = makeProvider([
      activeSession('h-z', { title: 'zebra', status: 'seen', updatedAt: new Date(0) }),
      activeSession('h-a', { title: 'apple', status: 'seen', updatedAt: new Date(0) }),
    ]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushHistory(): Promise<void> })._pushHistory();

    const rows = lastPush(postMessage, 'updateHistory')?.sessions ?? [];
    expect(rows.map(s => s.sessionId)).toEqual(['h-a', 'h-z']);
    expect(rows[0].workspaceColor?.background).toBe('#1f70c1');
  });

  it('leaves rows undecorated when the colour setting is malformed', async () => {
    withSettings({ workspaceColors: 'not an object' });
    const provider = makeProvider([activeSession('s1')]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(lastPush(postMessage, 'updateSessions')?.sessions[0].workspaceColor).toBeUndefined();
  });

  it('setSessionSort records the choice in the user settings and re-pushes the list', async () => {
    const update = withSettings({ sessionSort: 'recent' });
    const provider = makeProvider([activeSession('s1')]);
    const { postMessage, handler } = resolveWebviewCapturing(provider);
    await handler({ type: 'setSessionSort', mode: 'hostWorkspace' });

    // Global (ConfigurationTarget.Global === 1), so the order holds across a reload and across
    // windows — the session list is the same list in every window.
    expect(update).toHaveBeenCalledWith('sessionSort', 'hostWorkspace', 1);
    expect(lastPush(postMessage, 'updateSessions')).toBeDefined();
  });

  it('setSessionSort refuses a mode the sorter does not implement', async () => {
    const update = withSettings({ sessionSort: 'recent' });
    const provider = makeProvider([activeSession('s1')]);
    const { handler } = resolveWebviewCapturing(provider);
    await handler({ type: 'setSessionSort', mode: 'rm -rf' });

    expect(update).toHaveBeenCalledWith('sessionSort', 'recent', 1);
  });

  // Which row the panel marks as "the session you are in". Claude's manager is the only source
  // that reports a focused session, so it is the only one that can answer this — and the panel
  // exists to switch between sessions, so a list with nothing marked is the bug.
  it('names the focused Claude session as the current one', async () => {
    withSettings({});
    setClaudeOpenState({ panels: ['s1', 's2'], active: 's2' });
    const provider = makeProvider([activeSession('s1'), activeSession('s2')]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    expect(lastPush(postMessage, 'updateSessions')?.currentSessionId).toBe('s2');
  });

  it('marks nothing when no source reports a focused session', async () => {
    withSettings({});
    setClaudeOpenState({ panels: ['s1'], active: null });
    const provider = makeProvider([activeSession('s1')]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await (provider as unknown as { _pushSessions(): Promise<void> })._pushSessions();

    // Null, not a guess: marking the newest row would claim something we do not know.
    expect(lastPush(postMessage, 'updateSessions')?.currentSessionId).toBeNull();
  });

  it('repaints when either setting changes, and ignores unrelated setting changes', async () => {
    withSettings({});
    const provider = makeProvider([activeSession('s1')]);
    const { postMessage } = resolveWebviewCapturing(provider);
    const listener = mockOnDidChangeConfiguration.mock.calls.at(-1)?.[0] as unknown as
      (e: { affectsConfiguration(k: string): boolean }) => void;
    expect(listener).toBeTypeOf('function');

    const before = postMessage.mock.calls.length;
    listener({ affectsConfiguration: (k: string) => k === 'sessionSitter.workspaceColors' });
    await vi.waitFor(() => expect(postMessage.mock.calls.length).toBeGreaterThan(before), { timeout: 2000 });

    const after = postMessage.mock.calls.length;
    listener({ affectsConfiguration: () => false });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(postMessage.mock.calls.length).toBe(after);
  });
});

// ── Tests: the panel's own clock ──────────────────────────────────────────────
//
// Every age bound the panel applies — the 2h `working` fallback, the 24h finished→dormant split,
// the probeless recency window, and the pruning of a dead window's ids by `readLiveWindows` — is
// evaluated against `Date.now()` inside `_partitionSessions`. That only runs when the webview
// repaints, and every other repaint trigger is a CHANGE signal: `onDidChangeSessions` is gated on
// `sessionsFingerprint`, which stops moving the moment a session's raw status settles. So without a
// clock of its own the panel shows whatever verdict it last reached, for as long as nothing else in
// the fleet happens — which is how a day-old row sits in the worklist until you start a session
// somewhere else and the list silently corrects itself.
describe("the panel's own clock", () => {
  function resolveWebviewCapturing(
    provider: SessionSitterViewProvider, visible = true,
  ) {
    const postMessage = vi.fn();
    const webview = {
      options: {}, html: '', postMessage,
      // Returns a real disposable: this block calls `dispose()`, and the provider pushes whatever
      // this hands back into `_viewDisposables`.
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      asWebviewUri: (u: unknown) => u, cspSource: 'vscode-webview:',
    };
    provider.resolveWebviewView(
      { webview, onDidDispose: vi.fn(() => ({ dispose: vi.fn() })), visible } as unknown as import('vscode').WebviewView,
      {} as import('vscode').WebviewViewResolveContext,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as unknown as import('vscode').CancellationToken,
    );
    return { postMessage };
  }

  /** Session ids of the last `updateSessions` push, or undefined when none was made. */
  function lastActiveIds(postMessage: ReturnType<typeof vi.fn>): string[] | undefined {
    const pushes = postMessage.mock.calls
      .map(c => c[0] as { type: string; sessions?: Array<{ sessionId: string }> })
      .filter(m => m?.type === 'updateSessions');
    const last = pushes[pushes.length - 1];
    return last && (last.sessions ?? []).map(s => s.sessionId);
  }

  const START = new Date('2026-09-02T12:00:00Z').getTime();

  beforeEach(() => {
    mockReadLiveWindows.mockResolvedValue([]);
    vi.useFakeTimers({ now: START, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(() => { vi.useRealTimers(); });

  /** `working`, held by no window, last written `agoMs` ago. Its fingerprint will never move again. */
  function settledSession(sessionId: string, agoMs: number) {
    return {
      sessionId, projectPath: '/home/me/work/alpha', projectName: 'alpha', title: `t-${sessionId}`,
      updatedAt: new Date(START - agoMs),
      status: 'working' as const, source: 'claude' as const,
    };
  }

  it('ages a settled session out of the worklist with nothing else changing', async () => {
    // One minute inside STALE_FALLBACK_WINDOW_MS at START.
    const provider = makeProvider([settledSession('settled-1', 119 * 60_000)]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastActiveIds(postMessage)).toContain('settled-1');

    // Two minutes on it is past the window. No session changed, so only the panel's own clock can
    // notice — this is the assertion that fails without one.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(lastActiveIds(postMessage)).not.toContain('settled-1');
  });

  it('leaves a session inside its window alone', async () => {
    const provider = makeProvider([settledSession('fresh-1', 0)]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(lastActiveIds(postMessage)).toContain('fresh-1');
  });

  it('does not repaint behind a hidden view', async () => {
    // The probes reach into another extension host over the V8 inspector. Spending that on a panel
    // nobody is looking at buys nothing, and the next reveal repaints anyway.
    const provider = makeProvider([settledSession('hidden-1', 0)]);
    const { postMessage } = resolveWebviewCapturing(provider, false);
    await vi.advanceTimersByTimeAsync(0);
    const afterResolve = postMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(postMessage.mock.calls.length).toBe(afterResolve);
  });

  it('stops ticking once disposed', async () => {
    const provider = makeProvider([settledSession('disposed-1', 0)]);
    const { postMessage } = resolveWebviewCapturing(provider);
    await vi.advanceTimersByTimeAsync(0);
    provider.dispose();
    const afterDispose = postMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(postMessage.mock.calls.length).toBe(afterDispose);
  });
});

// ── Window attention ─────────────────────────────────────────────────────────
//
// `readLiveWindows` proves a publisher is running, which on a remote IDE is not the same as a
// person being there: closing the client window leaves the server-side extension host alive, still
// republishing the tabs that were open when you disconnected. These tests pin the second signal.

describe('window attention', () => {
  function published(): import('../WindowRegistry').WindowEntry {
    const calls = mockWriteWindowEntry.mock.calls;
    return calls[calls.length - 1][0] as import('../WindowRegistry').WindowEntry;
  }

  function session(sessionId: string, minutesAgo: number): import('../SessionManager').ClaudeSession {
    return {
      sessionId, projectPath: '/p', projectName: 'p', title: `t-${sessionId}`,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000), status: 'finished', source: 'claude',
    };
  }

  function windowEntry(lastActiveMinutesAgo: number): import('../WindowRegistry').WindowEntry {
    return {
      pid: 7, workspaceFolders: [], ideCli: 'bobide', ipcSocket: '', updatedAt: Date.now(),
      lastActiveAt: Date.now() - lastActiveMinutesAgo * 60_000,
      openClaudeSessionIds: ['c-abandoned'],
    };
  }

  /** Read the sessions the panel would render as the worklist. */
  async function worklist(
    provider: import('../SessionSitterViewProvider').SessionSitterViewProvider,
  ): Promise<string[]> {
    const partition = await provider.sessionPartition();
    return partition.active.map(s => s.sessionId);
  }

  /** Publish once, on demand — the constructor's own publish is fire-and-forget. */
  async function publish(
    provider: import('../SessionSitterViewProvider').SessionSitterViewProvider,
  ): Promise<void> {
    await (provider as unknown as { _publishWindowEntry(): Promise<void> })._publishWindowEntry();
  }

  beforeEach(() => {
    mockWriteWindowEntry.mockClear();
    mockReadLiveWindows.mockResolvedValue([]);
    setClaudeOpenState({});
    // A previous test may have left the window quiet; every test states its own starting point.
    (vscode.window.state as unknown as { active: boolean }).active = true;
  });

  it('publishes when this window was last interacted with', async () => {
    // Without a stamp there is nothing for a reader to bound, and a disconnected host looks
    // exactly like one you are typing in.
    const before = Date.now();
    await publish(makeProvider());
    expect(published().lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it('stops advancing the stamp once the window goes quiet', async () => {
    const provider = makeProvider();
    await publish(provider);
    const first = published().lastActiveAt;

    (vscode.window.state as unknown as { active: boolean }).active = false;
    await publish(provider);

    // Asserted as a number as well, so an implementation that publishes no stamp at all cannot
    // satisfy this by leaving both sides undefined.
    expect(first).toEqual(expect.any(Number));
    expect(published().lastActiveAt).toBe(first);
  });

  it('drops a session that only an unattended window reports open', async () => {
    // The bug: a peer whose IDE window was closed hours ago still names its old tabs.
    mockReadLiveWindows.mockResolvedValue([windowEntry(40)]);
    mockGetConfiguration.mockImplementation(() => ({ get: (k?: string, d?: unknown) =>
      k === 'windowAttentionMinutes' ? 30 : d }));

    expect(await worklist(makeProvider([session('c-abandoned', 5)]))).toEqual([]);
  });

  it('keeps a session an attended window reports open', async () => {
    mockReadLiveWindows.mockResolvedValue([windowEntry(5)]);
    mockGetConfiguration.mockImplementation(() => ({ get: (k?: string, d?: unknown) =>
      k === 'windowAttentionMinutes' ? 30 : d }));

    expect(await worklist(makeProvider([session('c-abandoned', 5)]))).toEqual(['c-abandoned']);
  });

  it('changes nothing at the default of zero', async () => {
    // Off unless asked for. The premise this rests on — that a disconnected extension host really
    // does stop reporting itself active — is not something the panel can verify from here.
    mockReadLiveWindows.mockResolvedValue([windowEntry(40)]);

    expect(await worklist(makeProvider([session('c-abandoned', 5)]))).toEqual(['c-abandoned']);
  });
});

describe('claudeSidebarViewId', () => {
  // Claude registers one provider for two view ids and chooses between them on the VS Code
  // version alone. Mirrored so our fallback focus lands in the container Claude uses.
  it('uses the secondary side bar from 1.106 onward', () => {
    expect(claudeSidebarViewId('1.106.0')).toBe('claudeVSCodeSidebarSecondary');
    expect(claudeSidebarViewId('1.107.2')).toBe('claudeVSCodeSidebarSecondary');
    expect(claudeSidebarViewId('2.0.0')).toBe('claudeVSCodeSidebarSecondary');
  });

  it('uses the activity bar side bar before 1.106, where no secondary side bar exists', () => {
    expect(claudeSidebarViewId('1.105.9')).toBe('claudeVSCodeSidebar');
    expect(claudeSidebarViewId('1.64.0')).toBe('claudeVSCodeSidebar');
  });

  it('falls back to the activity bar side bar for an unparseable version', () => {
    expect(claudeSidebarViewId('')).toBe('claudeVSCodeSidebar');
    expect(claudeSidebarViewId('nonsense')).toBe('claudeVSCodeSidebar');
  });
});
