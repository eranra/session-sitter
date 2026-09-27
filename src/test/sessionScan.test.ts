import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultStorePaths,
  liveSessionPids,
  readClaudeCodeTitleOverrides,
  scanClaudeSessions,
  vscodeUserDir,
  type ProcessProbe,
} from '../sessionScan';

// The rest of `sessionScan` is exercised through SessionManager.test.ts, which drives the same
// functions the panel calls. Only the store-path defaults are new here, and they are the one
// thing both front ends must agree on — the CLI and the extension would otherwise read different
// directories and disagree about which sessions exist.
describe('defaultStorePaths', () => {
  it('points every source at the agent that owns it', () => {
    const paths = defaultStorePaths('/home/u');
    expect(paths.projectsDir).toBe(path.join('/home/u', '.claude', 'projects'));
    expect(paths.bobDbPath).toBe(path.join('/home/u', '.bob', 'db', 'bob.db'));
    expect(paths.codexSessionsDir).toBe(path.join('/home/u', '.codex', 'sessions'));
    expect(paths.codexIndexPath).toBe(path.join('/home/u', '.codex', 'session_index.jsonl'));
  });

  it('derives the Chat directory from the platform rule, not a second copy of it', () => {
    expect(defaultStorePaths('/home/u').vscodeUserDir).toBe(vscodeUserDir('/home/u'));
  });
});

describe('liveSessionPids', () => {
  // A dead PID is a dead session on every platform; nothing below should reach the start-time check.
  const dead: ProcessProbe = {
    signal: () => { throw new Error('ESRCH'); },
    procStat: () => { throw new Error('unreachable'); },
    psStart: () => { throw new Error('unreachable'); },
  };
  // Linux keeps the start time in jiffies in field 21 of /proc/<pid>/stat — far enough along the
  // line that the fixture is easier to build by index than to write out.
  const linuxStat = (jiffies: string) => {
    const fields = ['42', '(node)', 'S', ...Array(18).fill('0')];
    fields[21] = jiffies;
    return `${fields.join(' ')} 100 200`;
  };
  // `ps` prints local time, so a fixture for it is derived from the UTC instant Claude recorded
  // rather than written out — otherwise the test would only pass in one time zone.
  const psRenderingOf = (procStart: string) => `${new Date(`${procStart} UTC`).toString()}    `;
  const noProc = { signal: () => {}, procStat: () => { throw new Error('ENOENT'); } };

  it('keeps the Linux /proc start-time comparison', async () => {
    const probe = (jiffies: string): ProcessProbe => ({
      signal: () => {},
      procStat: () => linuxStat(jiffies),
      psStart: () => { throw new Error('ps must not be consulted on Linux'); },
    });
    const one = [{ pid: 42, procStart: 993_311 }];
    expect(await liveSessionPids(one, 'linux', probe('993311'))).toEqual(new Set([42]));
    expect(await liveSessionPids(one, 'linux', probe('884422'))).toEqual(new Set());
    expect(await liveSessionPids(one, 'linux', dead)).toEqual(new Set());
  });

  it('treats an unreadable /proc on Linux as dead rather than guessing', async () => {
    expect(await liveSessionPids([{ pid: 42, procStart: 993_311 }], 'linux', {
      ...noProc,
      psStart: () => { throw new Error('unreachable'); },
    })).toEqual(new Set());
  });

  it('accepts a macOS session whose ps start-time matches the recorded one', async () => {
    const procStart = 'Mon Aug 31 10:04:57 2026';
    // Claude records procStart in UTC while `ps` prints the local zone, so the two differ by the
    // machine's offset even for one and the same process.
    expect(await liveSessionPids([{ pid: 1263, procStart }], 'darwin', {
      ...noProc, psStart: async () => new Map([[1263, psRenderingOf(procStart)]]),
    })).toEqual(new Set([1263]));
    // And a host whose two clocks agree — the strings identical — must still come out alive.
    expect(await liveSessionPids([{ pid: 1263, procStart }], 'darwin', {
      ...noProc, psStart: async () => new Map([[1263, procStart]]),
    })).toEqual(new Set([1263]));
  });

  it('rejects a recycled macOS PID whose ps start-time disagrees', async () => {
    expect(await liveSessionPids([{ pid: 1263, procStart: 'Mon Aug 31 10:04:57 2026' }], 'darwin', {
      ...noProc,
      psStart: async () => new Map([[1263, psRenderingOf('Tue Sep  1 03:45:23 2026')]]),
    })).toEqual(new Set());
  });

  it('asks ps about every candidate at once, and only about the live ones', async () => {
    const asked: number[][] = [];
    const born = 'Mon Aug 31 10:04:57 2026';
    const alive = await liveSessionPids(
      [
        { pid: 11, procStart: born },
        { pid: 22, procStart: 'Tue Sep  1 03:45:23 2026' },  // recycled — ps disagrees
        { pid: 33, procStart: born },
        { pid: 44, procStart: born },                        // already gone
      ],
      'darwin',
      {
        signal: (pid) => { if (pid === 44) { throw new Error('ESRCH'); } },
        procStat: () => { throw new Error('ENOENT'); },
        psStart: async (pids) => {
          asked.push(pids);
          return new Map(pids.map(pid => [pid, psRenderingOf(born)]));
        },
      },
    );
    expect(asked).toEqual([[11, 22, 33]]);
    expect(alive).toEqual(new Set([11, 33]));
  });

  it('trusts the signal alone when ps cannot be used', async () => {
    const procStart = 'Mon Aug 31 10:04:57 2026';
    const candidates = [{ pid: 1263, procStart }];
    const noPs: ProcessProbe = {
      ...noProc,
      psStart: () => Promise.reject(new Error('spawn ps ENOENT')),
    };
    expect(await liveSessionPids(candidates, 'darwin', noPs)).toEqual(new Set([1263]));
    // Same fallback when `ps` does run but says nothing usable about the PID.
    expect(await liveSessionPids(candidates, 'darwin', {
      ...noPs, psStart: async () => new Map([[1263, 'no date here']]),
    })).toEqual(new Set([1263]));
    expect(await liveSessionPids(candidates, 'darwin', {
      ...noPs, psStart: async () => new Map(),
    })).toEqual(new Set([1263]));
    // The fallback is on the start-time cross-check only — a dead PID is still dead.
    expect(await liveSessionPids(candidates, 'darwin', dead)).toEqual(new Set());
  });

  it('trusts the signal alone when the session file has no recorded procStart', async () => {
    // No recorded start time is no recycled-PID evidence either way, so a running PID must not be
    // filtered out just because ps has something usable to compare it against.
    const candidates = [{ pid: 1263, procStart: undefined }];
    expect(await liveSessionPids(candidates, 'darwin', {
      ...noProc,
      psStart: async () => new Map([[1263, 'Mon Aug 31 10:04:57 2026    ']]),
    })).toEqual(new Set([1263]));
  });
});

describe('readClaudeCodeTitleOverrides', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-override-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // `stat(dbPath)` must find a real file before the injected reader is ever consulted, so every
  // case below creates an empty `state.vscdb` on disk — its content is irrelevant since the
  // reader is injected.
  async function makeWorkspaceDb(hash: string): Promise<string> {
    const dbPath = path.join(tmpDir, 'workspaceStorage', hash, 'state.vscdb');
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.promises.writeFile(dbPath, '');
    return dbPath;
  }

  it('returns an empty map when workspaceStorage does not exist', async () => {
    const overrides = await readClaudeCodeTitleOverrides(tmpDir, async () => { throw new Error('unreachable'); });
    expect(overrides.size).toBe(0);
  });

  it('builds sessionId -> title from panelTabSessions, across every workspace', async () => {
    const dbA = await makeWorkspaceDb('hash-a');
    const dbB = await makeWorkspaceDb('hash-b');
    const overrides = await readClaudeCodeTitleOverrides(tmpDir, async (dbPath) => {
      if (dbPath === dbA) {
        return JSON.stringify({ panelTabSessions: [{ sessionId: 'sess-1', title: 'Renamed session' }] });
      }
      if (dbPath === dbB) {
        return JSON.stringify({ panelTabSessions: [{ sessionId: 'sess-2', title: 'Another rename' }] });
      }
      throw new Error(`unexpected dbPath ${dbPath}`);
    });
    expect(overrides.get('sess-1')).toBe('Renamed session');
    expect(overrides.get('sess-2')).toBe('Another rename');
  });

  it('skips a workspace whose state.vscdb cannot be read, keeping the others', async () => {
    const dbA = await makeWorkspaceDb('hash-a');
    await makeWorkspaceDb('hash-b');
    const overrides = await readClaudeCodeTitleOverrides(tmpDir, async (dbPath) => {
      if (dbPath === dbA) { throw new Error('database is locked'); }
      return JSON.stringify({ panelTabSessions: [{ sessionId: 'sess-2', title: 'Still readable' }] });
    });
    expect(overrides.size).toBe(1);
    expect(overrides.get('sess-2')).toBe('Still readable');
  });

  it('ignores a workspace with no Claude Code key recorded', async () => {
    await makeWorkspaceDb('hash-a');
    const overrides = await readClaudeCodeTitleOverrides(tmpDir, async () => undefined);
    expect(overrides.size).toBe(0);
  });

  it('ignores a malformed JSON value', async () => {
    await makeWorkspaceDb('hash-a');
    const overrides = await readClaudeCodeTitleOverrides(tmpDir, async () => 'not json');
    expect(overrides.size).toBe(0);
  });

  it('ignores an entry with a blank title', async () => {
    const dbA = await makeWorkspaceDb('hash-a');
    const overrides = await readClaudeCodeTitleOverrides(tmpDir, async (dbPath) => dbPath === dbA
      ? JSON.stringify({ panelTabSessions: [{ sessionId: 'sess-3', title: '   ' }] })
      : undefined);
    expect(overrides.size).toBe(0);
  });
});

// ── scanClaudeSessions: rename override end to end ───────────────────────────
//
// Everything above drives `readClaudeCodeTitleOverrides` with an injected reader, so it never
// touches real SQLite. This test instead builds a real `state.vscdb` the way `SessionManager.
// test.ts` already builds a real Bob db for the same reason: the bug this fixes is specifically
// about the on-disk format VS Code writes, and a fake reader can't catch a mismatch with that.
describe('scanClaudeSessions (rename override, real state.vscdb)', () => {
  let tmpDir: string;

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function createStateDb(dbPath: string, panelTabSessions: Array<{ sessionId: string; title: string }>): void {
    execFileSync('python3', ['-c', `
import sqlite3
conn = sqlite3.connect('${dbPath}')
conn.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
conn.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)",
    ('Anthropic.claude-code', ${JSON.stringify(JSON.stringify({ panelTabSessions }))}))
conn.commit()
conn.close()
`]);
  }

  it('overrides the transcript title with the workspace state.vscdb rename', async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-claude-override-'));
    const projectsDir = path.join(tmpDir, 'projects');
    await fs.promises.mkdir(projectsDir, { recursive: true });

    const sessionId = 'a3a81f8f-0000-0000-0000-000000000001';
    const jsonlPath = path.join(projectsDir, `${sessionId}.jsonl`);
    const lines = [
      { type: 'user', cwd: '/home/u/cap-evolve', message: { content: 'raw first message' } },
      { type: 'assistant', message: { content: 'ok' } },
      { type: 'ai-title', sessionId, aiTitle: 'stale ai title' },
    ];
    await fs.promises.writeFile(jsonlPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const vscodeUserDirPath = path.join(tmpDir, 'User');
    const dbPath = path.join(vscodeUserDirPath, 'workspaceStorage', 'hash-1', 'state.vscdb');
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    createStateDb(dbPath, [{ sessionId, title: 'renamed session' }]);

    // Without the override: the stale ai-title from the transcript.
    const withoutOverride = await scanClaudeSessions(projectsDir);
    expect(withoutOverride[0].title).toBe('stale ai title');

    // With it: the rename VS Code's own UI shows.
    const withOverride = await scanClaudeSessions(projectsDir, new Map(), new Map(), vscodeUserDirPath);
    expect(withOverride[0].title).toBe('renamed session');
  });

  it('leaves a session with no matching panelTabSessions entry untouched', async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ss-claude-override-'));
    const projectsDir = path.join(tmpDir, 'projects');
    await fs.promises.mkdir(projectsDir, { recursive: true });

    const sessionId = 'b3a81f8f-0000-0000-0000-000000000002';
    const jsonlPath = path.join(projectsDir, `${sessionId}.jsonl`);
    await fs.promises.writeFile(jsonlPath, JSON.stringify(
      { type: 'user', cwd: '/home/u/cap-evolve', message: { content: 'never renamed' } },
    ) + '\n');

    const vscodeUserDirPath = path.join(tmpDir, 'User');
    const dbPath = path.join(vscodeUserDirPath, 'workspaceStorage', 'hash-1', 'state.vscdb');
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    createStateDb(dbPath, [{ sessionId: 'some-other-session', title: 'unrelated rename' }]);

    const sessions = await scanClaudeSessions(projectsDir, new Map(), new Map(), vscodeUserDirPath);
    expect(sessions[0].title).toBe('never renamed');
  });
});
