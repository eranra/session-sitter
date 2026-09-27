import { describe, expect, it } from 'vitest';
import {
  canInject,
  daemonClaimantFrom,
  injectionBlocker,
  isWritableSource,
  ownedByAWindow,
  ownedByThisWindow,
  pathContains,
  resolveOwner,
  resolveOwners,
  writeBlockedReason,
  type Ownership,
} from '../../telegram/ownership';
import type { ClaudeSession } from '../../SessionManager';
import type { WindowEntry } from '../../WindowRegistry';

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    projectName: 'app',
    projectPath: '/work/app',
    title: 'a title',
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    status: 'working',
    source: 'claude',
    ...over,
  };
}

function window(over: Partial<WindowEntry> = {}): WindowEntry {
  return {
    pid: 100,
    workspaceFolders: ['/work/app'],
    ideCli: 'code',
    ipcSocket: '/tmp/sock',
    updatedAt: Date.now(),
    ...over,
  };
}

describe('pathContains', () => {
  it('matches the folder itself and its descendants', () => {
    expect(pathContains('/work/app', '/work/app')).toBe(true);
    expect(pathContains('/work/app', '/work/app/src/index.ts')).toBe(true);
  });

  it('does not let a folder claim a sibling with a shared prefix', () => {
    // The bug this guards: '/work/app' must not own a session in '/work/app-legacy'.
    expect(pathContains('/work/app', '/work/app-legacy')).toBe(false);
  });

  it('ignores a trailing separator on the folder', () => {
    expect(pathContains('/work/app/', '/work/app/sub')).toBe(true);
  });

  it('never matches on an empty folder', () => {
    expect(pathContains('', '/work/app')).toBe(false);
    expect(pathContains('/', '/work/app')).toBe(false);
  });
});

describe('resolveOwner', () => {
  it('prefers the window that actually holds the session', () => {
    const holder = window({ pid: 200, workspaceFolders: ['/elsewhere'], openClaudeSessionIds: ['s1'] });
    const byPath = window({ pid: 100, workspaceFolders: ['/work/app'] });
    const owner = resolveOwner(session(), [byPath, holder]);
    expect(owner).toEqual({ pid: 200, basis: 'holds', workspace: '/elsewhere' });
  });

  it('recognises a Bob task id as held', () => {
    const holder = window({ pid: 300, openBobTaskIds: ['task-9'] });
    const owner = resolveOwner(session({ sessionId: 'task-9', source: 'bob' }), [holder]);
    expect(owner.basis).toBe('holds');
    expect(owner.pid).toBe(300);
  });

  it('falls back to the longest containing workspace', () => {
    // The worktree case this project creates on purpose: the session's cwd is a subdirectory of
    // one window's workspace and the exact workspace of another. The deeper one must win.
    const parent = window({ pid: 100, workspaceFolders: ['/work/app'] });
    const worktree = window({ pid: 101, workspaceFolders: ['/work/app/.claude/worktrees/feat'] });
    const owner = resolveOwner(
      session({ projectPath: '/work/app/.claude/worktrees/feat' }), [parent, worktree]);
    expect(owner).toEqual({
      pid: 101, basis: 'workspace', workspace: '/work/app/.claude/worktrees/feat',
    });
  });

  it('still claims a session in a subdirectory when only the parent is open', () => {
    const parent = window({ pid: 100, workspaceFolders: ['/work/app'] });
    const owner = resolveOwner(session({ projectPath: '/work/app/.claude/worktrees/feat' }), [parent]);
    expect(owner.pid).toBe(100);
    expect(owner.basis).toBe('workspace');
  });

  it('breaks a workspace tie on the lowest pid so every window agrees', () => {
    const a = window({ pid: 400, workspaceFolders: ['/work/app'] });
    const b = window({ pid: 200, workspaceFolders: ['/work/app'] });
    expect(resolveOwner(session(), [a, b]).pid).toBe(200);
    expect(resolveOwner(session(), [b, a]).pid).toBe(200);
  });

  it('breaks a holder tie on the lowest pid too', () => {
    const a = window({ pid: 400, openClaudeSessionIds: ['s1'] });
    const b = window({ pid: 200, openClaudeSessionIds: ['s1'] });
    expect(resolveOwner(session(), [a, b]).pid).toBe(200);
  });

  it('leaves a session unowned when no window matches', () => {
    const other = window({ pid: 100, workspaceFolders: ['/somewhere/else'] });
    expect(resolveOwner(session(), [other]).basis).toBe('none');
    expect(resolveOwner(session(), []).pid).toBeNull();
  });

  it('never lets a local window own a session on another machine', () => {
    // A peer session is reachable read-only over SSH; only that machine can act on it.
    const holder = window({ pid: 100, openClaudeSessionIds: ['s1'], workspaceFolders: ['/work/app'] });
    expect(resolveOwner(session({ peer: 'me@laptop2' }), [holder]).pid).toBeNull();
  });
});

describe('resolveOwners', () => {
  it('keys the result by session id', () => {
    const windows = [window({ pid: 100 })];
    const owners = resolveOwners([session({ sessionId: 'a' }), session({ sessionId: 'b' })], windows);
    expect([...owners.keys()].sort()).toEqual(['a', 'b']);
    expect(owners.get('a')?.pid).toBe(100);
  });
});

describe('isWritableSource', () => {
  it('allows only the agents that expose a message API', () => {
    expect(isWritableSource('bob')).toBe(true);
    expect(isWritableSource('claude')).toBe(true);
    expect(isWritableSource('codex')).toBe(false);
    expect(isWritableSource('chat')).toBe(false);
  });
});

describe('writeBlockedReason', () => {
  const owned = { pid: 100, basis: 'holds' as const, workspace: '/work/app' };

  it('passes a writable, owned session', () => {
    expect(writeBlockedReason(session(), owned)).toBeNull();
  });

  it('reports a peer session by naming the machine', () => {
    const reason = writeBlockedReason(session({ peer: 'me@laptop2' }), owned);
    expect(reason).toContain('me@laptop2');
  });

  it('names the agent when the source has no message API', () => {
    expect(writeBlockedReason(session({ source: 'codex' }), owned)).toContain('Codex');
    expect(writeBlockedReason(session({ source: 'chat' }), owned)).toContain('VS Code Chat');
  });

  it('explains an unowned session rather than failing later', () => {
    const reason = writeBlockedReason(session(), { pid: null, basis: 'none', workspace: '' });
    expect(reason).toContain('No open window');
  });

  // A peer session's own machine also has no message API for Codex, but the peer message is the
  // more actionable one, so it must win.
  it('reports the peer before the source when both apply', () => {
    const reason = writeBlockedReason(session({ peer: 'me@laptop2', source: 'codex' }), owned);
    expect(reason).toContain('laptop2');
  });
});

// ── The daemon as a claimant ────────────────────────────────────────────────

const DAEMON = { pid: 9001 };

describe('the daemon tier', () => {
  /**
   * The gap this closes. With no VS Code at all, tiers 1 and 2 find nothing, so every session was
   * read-only — a terminal-only fleet could be neither listed nor answered.
   */
  it('claims a session no window claims', () => {
    expect(resolveOwner(session(), [], DAEMON))
      .toEqual({ pid: 9001, basis: 'daemon', workspace: '' });
  });

  it('leaves a session read-only when there is no daemon either', () => {
    expect(resolveOwner(session(), [], null).basis).toBe('none');
  });

  /**
   * Below both window tiers, and not because a window is more trustworthy: a window can do strictly
   * more — text can be written into it. Claiming first would take a session that could be answered
   * from a phone and hand it to an owner that can only watch.
   */
  it('never outranks a window that holds the session', () => {
    const holder = window({ pid: 100, openClaudeSessionIds: ['s1'] });
    expect(resolveOwner(session(), [holder], DAEMON)).toMatchObject({ pid: 100, basis: 'holds' });
  });

  it('never outranks a window that owns the workspace', () => {
    const byPath = window({ pid: 101, workspaceFolders: ['/work/app'] });
    expect(resolveOwner(session(), [byPath], DAEMON))
      .toMatchObject({ pid: 101, basis: 'workspace' });
  });

  it('does not claim a session on another machine', () => {
    // Only that machine's own processes can act on it, daemon or otherwise.
    expect(resolveOwner(session({ peer: 'buildbox' }), [], DAEMON).basis).toBe('none');
  });

  it('resolves a whole fleet in one pass', () => {
    const sessions = [session({ sessionId: 's1' }), session({ sessionId: 's2' })];
    expect([...resolveOwners(sessions, [], DAEMON).values()].map(o => o.basis))
      .toEqual(['daemon', 'daemon']);
  });

  it('answers "is that me" for a daemon exactly as it does for a window', () => {
    expect(ownedByThisWindow(session(), [], 9001, DAEMON)).toBe(true);
    expect(ownedByThisWindow(session(), [], 9002, DAEMON)).toBe(false);
  });
});

describe('daemonClaimantFrom', () => {
  it('claims only while the daemon is actually working', () => {
    expect(daemonClaimantFrom({ pid: 9001 }, 'running')).toEqual({ pid: 9001 });
  });

  /**
   * A `stale` daemon — process alive, passes stopped — must not claim. It would take sessions off the
   * read-only tier and then fail to mirror or answer them, which is worse than nobody claiming them:
   * the list would say somebody had.
   */
  it('does not claim when wedged, dead, or absent', () => {
    for (const health of ['stale', 'dead', 'none', 'oneshot']) {
      expect(daemonClaimantFrom({ pid: 9001 }, health), health).toBeNull();
    }
    expect(daemonClaimantFrom(null, 'running')).toBeNull();
  });
});

describe('canInject', () => {
  const owner = (basis: Ownership['basis'], pid: number | null = 1): Ownership =>
    ({ pid, basis, workspace: '' });

  it('is true only for a window, the only thing with an extension host', () => {
    expect(canInject(owner('holds'))).toBe(true);
    expect(canInject(owner('workspace'))).toBe(true);
  });

  it('is false for the daemon, which can mirror and answer but not type', () => {
    expect(canInject(owner('daemon', 9001))).toBe(false);
  });

  it('is false for nobody', () => {
    expect(canInject(owner('none', null))).toBe(false);
  });
});

describe('injectionBlocker', () => {
  it('is null when the owner can write', () => {
    expect(injectionBlocker({ pid: 1, basis: 'holds', workspace: '' })).toBeNull();
  });

  /**
   * The sentence goes straight into a Telegram topic, so it has to say what happened *and* what to do.
   * "Read-only" alone would leave someone assuming the feature is broken.
   */
  it('explains the daemon case and names the fix', () => {
    const why = injectionBlocker({ pid: 9001, basis: 'daemon', workspace: '' }) ?? '';
    expect(why).toContain('daemon');
    expect(why).toContain('extension host');
    expect(why).toContain('Open the session in an IDE window');
  });

  it('distinguishes "nobody claims it" from "the daemon claims it"', () => {
    const nobody = injectionBlocker({ pid: null, basis: 'none', workspace: '' }) ?? '';
    expect(nobody).toContain('no window or daemon');
    expect(nobody).not.toContain('extension host');
  });
});

describe('ownedByAWindow', () => {
  const owner = (basis: Ownership['basis'], pid: number | null = 1): Ownership =>
    ({ pid, basis, workspace: '' });

  /**
   * The gap this closes: mirroring a Telegram topic used to require a window's own pid to match
   * the owner, so a session claimed by the daemon — or by nobody, when no daemon runs either — was
   * never revisited by anyone once the window that opened it closed. It could sit weeks behind the
   * transcript's real title while the panel, which rescans on every render regardless of ownership,
   * kept showing the current one. This is the predicate the reader now uses to pick up that slack.
   */
  it('is true only for a window, the tiers that can actually run RemoteControlService', () => {
    expect(ownedByAWindow(owner('holds'))).toBe(true);
    expect(ownedByAWindow(owner('workspace'))).toBe(true);
  });

  it('is false for the daemon, which claims the session but runs no mirror loop', () => {
    expect(ownedByAWindow(owner('daemon', 9001))).toBe(false);
  });

  it('is false for nobody', () => {
    expect(ownedByAWindow(owner('none', null))).toBe(false);
  });
});

describe('writeBlockedReason, with a daemon owner', () => {
  const byDaemon: Ownership = { pid: 9001, basis: 'daemon', workspace: '' };

  it('reports up front that a daemon-held session cannot be typed into', () => {
    // Said in the topic header, rather than after someone has typed a message and waited for it.
    const why = writeBlockedReason(session(), byDaemon) ?? '';
    expect(why).toContain('daemon');
    expect(why).toContain('Open the session in an IDE window');
  });

  it('still says nothing when a window owns it', () => {
    expect(writeBlockedReason(session(), { pid: 100, basis: 'holds', workspace: '' })).toBeNull();
  });

  it('still prefers the peer and unwritable-source reasons, which are more specific', () => {
    expect(writeBlockedReason(session({ peer: 'buildbox' }), byDaemon)).toContain('runs on buildbox');
    expect(writeBlockedReason(session({ source: 'codex' }), byDaemon)).toContain('no message API');
  });
});
