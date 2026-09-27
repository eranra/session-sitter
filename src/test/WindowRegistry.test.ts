import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectIdeCli, discoverOwnIpcSocket, discoverOwnIpcSocketDarwin, isAttendedWindow, type ProcFs,
  writeWindowEntry, readLiveWindows, removeWindowEntry, windowsDir, type WindowEntry,
} from '../WindowRegistry';

function fakeProc(tree: Record<number, { ppid: number; environ?: string }>): ProcFs {
  return {
    listPids: () => Object.keys(tree).map(Number),
    readPpid: (pid) => tree[pid]?.ppid ?? 1,
    readEnviron: (pid) => tree[pid]?.environ ?? '',
  };
}

describe('detectIdeCli', () => {
  it('returns the remote-cli executable path when present (IBM Bob)', () => {
    const execPath = '/home/u/.bobide-server/bin/abc123/node';
    const readdir = vi.fn().mockReturnValue(['helpers', 'bobide', '.keep']);
    expect(detectIdeCli(execPath, 'IBM Bob', readdir)).toBe(
      '/home/u/.bobide-server/bin/abc123/bin/remote-cli/bobide',
    );
    expect(readdir).toHaveBeenCalledWith('/home/u/.bobide-server/bin/abc123/bin/remote-cli');
  });

  it('falls back to "bobide" by appName when remote-cli dir is unreadable', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'IBM Bob', readdir)).toBe('bobide');
  });

  it('falls back to "code" for VS Code desktop', () => {
    const readdir = vi.fn(() => { throw new Error('ENOENT'); });
    expect(detectIdeCli('/usr/lib/code/node', 'Visual Studio Code', readdir)).toBe('code');
  });
});

describe('discoverOwnIpcSocket', () => {
  const SOCK = '/run/user/1000/vscode-ipc-abc.sock';

  it('returns the socket carried by a descendant of selfPid', () => {
    const proc = fakeProc({
      100: { ppid: 1 },                                   // server
      200: { ppid: 100 },                                 // our ext host (selfPid)
      300: { ppid: 200, environ: `PATH=/x\0VSCODE_IPC_HOOK_CLI=${SOCK}\0` }, // descendant
    });
    expect(discoverOwnIpcSocket(200, proc)).toBe(SOCK);
  });

  it('ignores sockets carried by processes from another window', () => {
    const proc = fakeProc({
      200: { ppid: 1 },                                   // our ext host
      900: { ppid: 1 },                                   // another window ext host
      901: { ppid: 900, environ: `VSCODE_IPC_HOOK_CLI=/run/other.sock\0` },
    });
    expect(discoverOwnIpcSocket(200, proc)).toBeNull();
  });

  it('returns null when no descendant carries the var', () => {
    const proc = fakeProc({ 200: { ppid: 1 }, 300: { ppid: 200, environ: 'PATH=/x\0' } });
    expect(discoverOwnIpcSocket(200, proc)).toBeNull();
  });
});

describe('discoverOwnIpcSocketDarwin', () => {
  // A real `lsof -p <pid> -Fn` capture, trimmed to the lines that matter: the fd type marker
  // lines ('f...') are not filtered on, only the 'n<path>' lines, exactly as they came back from
  // the window this was diagnosed against.
  const LSOF_FN = [
    'p4835',
    'fcwd',
    'n/',
    'ftxt',
    'n/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app',
    'f32u',
    'n/var/folders/bd/T/vscode-git-9e331873c6.sock',
    'f63u',
    'n/var/folders/bd/T/mcp-H9LuZ5/mcp.sock',
    'f76u',
    'n/tmp/Visual Studio Code-e5642e1a-ed12-4f3e-86f0-021d0bc7c468.sock',
  ].join('\n');

  it('finds the IPC hook socket among everything else the process holds open', () => {
    const listOpenFiles = vi.fn().mockReturnValue(LSOF_FN);
    expect(discoverOwnIpcSocketDarwin(4835, listOpenFiles)).toBe(
      '/tmp/Visual Studio Code-e5642e1a-ed12-4f3e-86f0-021d0bc7c468.sock',
    );
    expect(listOpenFiles).toHaveBeenCalledWith(4835);
  });

  it('is not fooled by the other sockets the same process holds', () => {
    // Same fixture minus the real IPC socket line: vscode-git's shorter hash and the bare
    // mcp.sock must not match the UUID-suffix pattern.
    const withoutRealSocket = LSOF_FN.split('\n')
      .filter(l => !l.includes('Visual Studio Code-e5642e1a'))
      .join('\n');
    expect(discoverOwnIpcSocketDarwin(4835, () => withoutRealSocket)).toBeNull();
  });

  it("ignores Codex's own ipc.sock, which has no UUID suffix either", () => {
    const lines = `${LSOF_FN}\nn/Users/u/.codex/ipc/ipc.sock`;
    expect(discoverOwnIpcSocketDarwin(4835, () => lines)).toBe(
      '/tmp/Visual Studio Code-e5642e1a-ed12-4f3e-86f0-021d0bc7c468.sock',
    );
  });

  it('returns null when lsof itself fails', () => {
    expect(discoverOwnIpcSocketDarwin(4835, () => '')).toBeNull();
  });
});

describe('window registry files', () => {
  let home: string;
  beforeEach(async () => { home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wr-')); });
  afterEach(async () => { await fs.promises.rm(home, { recursive: true, force: true }); });

  const entry = (pid: number): WindowEntry => ({
    pid, workspaceFolders: [`/ws/${pid}`], ideCli: 'bobide', ipcSocket: `/s/${pid}.sock`, updatedAt: 1000,
  });

  it('round-trips a live entry', async () => {
    await writeWindowEntry(entry(42), home);
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 2000 });
    expect(live).toEqual([entry(42)]);
  });

  it('drops dead pids and unlinks their files', async () => {
    await writeWindowEntry(entry(42), home);
    const live = await readLiveWindows({ homedir: home, isAlive: () => false, now: 2000 });
    expect(live).toEqual([]);
    expect(fs.existsSync(path.join(windowsDir(home), '42.json'))).toBe(false);
  });

  it('drops entries older than 24h', async () => {
    await writeWindowEntry(entry(42), home); // updatedAt 1000
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 1000 + 25 * 3600 * 1000 });
    expect(live).toEqual([]);
  });

  it('removeWindowEntry deletes the file', async () => {
    await writeWindowEntry(entry(42), home);
    await removeWindowEntry(42, home);
    expect(fs.existsSync(path.join(windowsDir(home), '42.json'))).toBe(false);
  });

  it('leaves no temporary file behind, and never reads one as an entry', async () => {
    // Entries are written to a temp name and renamed, so a reader mid-write sees the old file or
    // the new one, never a fragment. A leftover .tmp- must not be picked up as a window either.
    await writeWindowEntry(entry(42), home);
    const files = await fs.promises.readdir(windowsDir(home));
    expect(files).toEqual(['42.json']);
  });

  it('ignores a temporary file that a crashed write left behind', async () => {
    await writeWindowEntry(entry(42), home);
    await fs.promises.writeFile(path.join(windowsDir(home), '43.json.tmp-abcd1234'), '{"pid":43}');
    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: 2000 });
    expect(live.map(w => w.pid)).toEqual([42]);
  });

  it('cleans up an unparsable entry once it is old enough to be certainly dead', async () => {
    // The leak this pins: cleanup only ever ran *after* a successful parse, so a truncated write
    // stayed forever. Two 0-byte entries sat in a real registry for a month.
    const orphan = path.join(windowsDir(home), '99.json');
    await fs.promises.mkdir(windowsDir(home), { recursive: true });
    await fs.promises.writeFile(orphan, '');
    const old = new Date(Date.now() - 26 * 3600 * 1000);
    await fs.promises.utimes(orphan, old, old);

    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: Date.now() });
    expect(live).toEqual([]);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('leaves a fresh unparsable entry alone rather than risking a live window', async () => {
    // Deleting on sight would make a window mid-recovery invisible to every other window until its
    // next publish. Skipping it costs nothing in the meantime.
    const fresh = path.join(windowsDir(home), '98.json');
    await fs.promises.mkdir(windowsDir(home), { recursive: true });
    await fs.promises.writeFile(fresh, '{ partial');

    const live = await readLiveWindows({ homedir: home, isAlive: () => true, now: Date.now() });
    expect(live).toEqual([]);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('cleans up an entry that parses but is not a window record', async () => {
    const bogus = path.join(windowsDir(home), '97.json');
    await fs.promises.mkdir(windowsDir(home), { recursive: true });
    await fs.promises.writeFile(bogus, '{"hello":"world"}');
    const old = new Date(Date.now() - 26 * 3600 * 1000);
    await fs.promises.utimes(bogus, old, old);

    await readLiveWindows({ homedir: home, isAlive: () => true, now: Date.now() });
    expect(fs.existsSync(bogus)).toBe(false);
  });
});

describe('isAttendedWindow', () => {
  const NOW = 10_000_000;
  const win = (over: Partial<WindowEntry> = {}): WindowEntry => ({
    pid: 42, workspaceFolders: ['/ws'], ideCli: 'bobide', ipcSocket: '/s.sock', updatedAt: NOW, ...over,
  });

  it('is off entirely at a zero window', () => {
    // The default. Nothing about a window's attention changes the session list until it is set.
    const long_gone = win({ lastActiveAt: NOW - 30 * 86400_000 });
    expect(isAttendedWindow(long_gone, 0, NOW)).toBe(true);
  });

  it('counts a window interacted with inside the window', () => {
    expect(isAttendedWindow(win({ lastActiveAt: NOW - 60_000 }), 30 * 60_000, NOW)).toBe(true);
  });

  it('stops counting a window nobody has touched since before the window', () => {
    // The disconnected remote host: its extension host still runs and still republishes, but no
    // client has been attached to it since the stamp.
    expect(isAttendedWindow(win({ lastActiveAt: NOW - 31 * 60_000 }), 30 * 60_000, NOW)).toBe(false);
  });

  it('counts a window sitting exactly on the bound', () => {
    expect(isAttendedWindow(win({ lastActiveAt: NOW - 30 * 60_000 }), 30 * 60_000, NOW)).toBe(true);
  });

  it('counts an entry that carries no stamp at all', () => {
    // An older build on a peer, or a host whose WindowState has no `active`. Absence of the signal
    // must never be read as absence of a person — that would hide sessions the panel used to show.
    expect(isAttendedWindow(win(), 30 * 60_000, NOW)).toBe(true);
  });
});
