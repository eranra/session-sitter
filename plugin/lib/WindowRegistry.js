// GENERATED FILE — DO NOT EDIT.
// Compiled from src/WindowRegistry.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectIdeCli = detectIdeCli;
exports.discoverOwnIpcSocket = discoverOwnIpcSocket;
exports.discoverOwnIpcSocketDarwin = discoverOwnIpcSocketDarwin;
exports.isAttendedWindow = isAttendedWindow;
exports.windowsDir = windowsDir;
exports.writeWindowEntry = writeWindowEntry;
exports.removeWindowEntry = removeWindowEntry;
exports.readLiveWindows = readLiveWindows;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const paths_1 = require("./hooks/paths");
const HELPER_NAMES = new Set(['helpers']);
// Determine the CLI used to focus a window. On remote IDEs the launcher lives in
// <serverBin>/bin/remote-cli/ next to the node execPath (Bob → "bobide", VS Code → "code").
// Returns an absolute path when found, else a bare name resolved via PATH.
function detectIdeCli(execPath = process.execPath, appName = '', readdir = fs.readdirSync) {
    const cliDir = path.join(path.dirname(execPath), 'bin', 'remote-cli');
    try {
        const exec = readdir(cliDir).find(e => !HELPER_NAMES.has(e) && !e.startsWith('.'));
        if (exec) {
            return path.join(cliDir, exec);
        }
    }
    catch { /* not a remote IDE layout */ }
    if (appName.toLowerCase().includes('bob')) {
        return 'bobide';
    }
    return 'code';
}
const realProcFs = {
    listPids: () => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number),
    readEnviron: (pid) => { try {
        return fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    }
    catch {
        return '';
    } },
    readPpid: (pid) => {
        try {
            // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may contain spaces/parens,
            // so parse after the last ')'.
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
            return parseInt(after[1], 10) || 1; // fields after comm: state(0), ppid(1)
        }
        catch {
            return 1;
        }
    },
};
function isDescendantOf(pid, ancestor, proc) {
    let cur = pid;
    for (let i = 0; i < 64 && cur > 1; i++) {
        const ppid = proc.readPpid(cur);
        if (ppid === ancestor) {
            return true;
        }
        if (ppid === cur) {
            break;
        }
        cur = ppid;
    }
    return false;
}
// Find this window's own VSCODE_IPC_HOOK_CLI by scanning descendant processes.
// Returns null on platforms without /proc or when no descendant carries the var.
function discoverOwnIpcSocket(selfPid = process.pid, proc = realProcFs) {
    let pids;
    try {
        pids = proc.listPids();
    }
    catch {
        return null;
    }
    for (const pid of pids) {
        const env = proc.readEnviron(pid);
        const m = env.split('\0').find(e => e.startsWith('VSCODE_IPC_HOOK_CLI='));
        if (!m) {
            continue;
        }
        if (pid === selfPid || isDescendantOf(pid, selfPid, proc)) {
            return m.slice('VSCODE_IPC_HOOK_CLI='.length);
        }
    }
    return null;
}
// A VS Code CLI IPC hook socket, wherever it sits directly under /tmp: `<app name>-<uuid>.sock`.
// The full UUID suffix is what tells it apart from every *other* socket this same process holds —
// `vscode-git-<10 hex>.sock` (a shorter hash, no dashes in that shape), a bare `mcp.sock`, Codex's
// own `ipc.sock` — none of which end in one, so nothing else here is ever mistaken for it.
const IPC_HOOK_SOCKET_RE = /^\/tmp\/.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sock$/i;
/**
 * `discoverOwnIpcSocket`'s counterpart for platforms with no `/proc` (macOS today; the same
 * approach would cover Windows, but named sockets there don't sit under a scannable directory the
 * same way and this has not been tried).
 *
 * The reason that function exists at all — the extension host's own `process.env` does not
 * reliably carry `VSCODE_IPC_HOOK_CLI` — holds here too, so the `??` fallback in
 * `_publishWindowEntry` was silently landing on `''` on every Mac, which is what made focusing a
 * session in *another* window fail outright (`ipcSocket` empty → `_tryFocusForeignWindow` returns
 * `'foreign-failed'` before ever trying). But unlike Linux, nothing needs scanning a descendant
 * process for this: VS Code's CLI IPC hook is a plain socket file the host holds open on *itself*
 * to listen for CLI connections, and `lsof -p <pid>` lists every fd a process holds, itself
 * included — confirmed against a real window on this machine, whose discovered socket did focus
 * that exact window via `code --reuse-window`.
 */
function discoverOwnIpcSocketDarwin(selfPid = process.pid, listOpenFiles = (pid) => {
    try {
        return (0, child_process_1.execFileSync)('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' });
    }
    catch {
        return '';
    }
}) {
    for (const line of listOpenFiles(selfPid).split('\n')) {
        // `-Fn` prints one open file per line as `n<path>`; matching from index 1 so a socket path
        // that itself started with the letter 'n' could never register as the wrong field.
        if (line.startsWith('n') && IPC_HOOK_SOCKET_RE.test(line.slice(1))) {
            return line.slice(1);
        }
    }
    return null;
}
const STALE_MS = 24 * 60 * 60 * 1000;
/**
 * Has anyone been at this window recently enough for its open-tab report to mean anything?
 *
 * `readLiveWindows` and the peer probe both answer "is the publisher alive", which is not the same
 * question and comes apart on a remote IDE: closing the client window leaves the server-side
 * extension host running, so it stays alive by `process.kill` and keeps refreshing an entry naming
 * the tabs that were open when you disconnected.
 *
 * Fails open in both directions that matter. A zero window turns the rule off, and an entry with no
 * stamp counts as attended — because reading a missing signal as "nobody is here" would hide
 * sessions from the worklist for a reason the user cannot see.
 */
function isAttendedWindow(entry, attentionWindowMs, now) {
    if (attentionWindowMs <= 0) {
        return true;
    }
    if (typeof entry.lastActiveAt !== 'number') {
        return true;
    }
    return entry.lastActiveAt >= now - attentionWindowMs;
}
function windowsDir(homedir = os.homedir()) {
    return path.join((0, paths_1.claudeDir)(process.env, homedir), 'session-sitter', 'windows');
}
/**
 * Publish this window's entry, atomically.
 *
 * Written to a temporary name and renamed into place, because every other window *reads* this
 * directory on a timer. A direct `writeFile` truncates first, so a reader arriving mid-write sees an
 * empty or half-written file — and a process killed between the truncate and the write leaves one
 * behind permanently. Both were observed: two 0-byte entries sat in a real registry for a month.
 * `rename` is atomic on every platform this runs on, so a reader sees either the old entry or the
 * new one, never a fragment. `TopicStore.save` writes for the same reason.
 */
async function writeWindowEntry(entry, homedir = os.homedir()) {
    const dir = windowsDir(homedir);
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${entry.pid}.json`);
    const tmp = `${target}.tmp-${(0, crypto_1.randomBytes)(4).toString('hex')}`;
    await fs.promises.writeFile(tmp, JSON.stringify(entry), 'utf8');
    await fs.promises.rename(tmp, target);
}
async function removeWindowEntry(pid, homedir = os.homedir()) {
    try {
        await fs.promises.unlink(path.join(windowsDir(homedir), `${pid}.json`));
    }
    catch { /* gone */ }
}
async function readLiveWindows(opts = {}) {
    const homedir = opts.homedir ?? os.homedir();
    const isAlive = opts.isAlive ?? ((pid) => { try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    } });
    const now = opts.now ?? Date.now();
    const dir = windowsDir(homedir);
    let files;
    try {
        files = (await fs.promises.readdir(dir))
            .filter(f => f.endsWith('.json') && !f.includes('.tmp-'));
    }
    catch {
        return [];
    }
    const out = [];
    for (const file of files) {
        const full = path.join(dir, file);
        let data;
        try {
            data = JSON.parse(await fs.promises.readFile(full, 'utf8'));
        }
        catch {
            // Unreadable or not JSON. Skipped either way, but it also has to be *cleaned*: the old code
            // only ever deleted an entry after parsing it, so a truncated write leaked forever.
            await unlinkIfStale(full, now);
            continue;
        }
        if (typeof data.pid !== 'number' || !Array.isArray(data.workspaceFolders)) {
            await unlinkIfStale(full, now);
            continue;
        }
        if (!isAlive(data.pid) || now - data.updatedAt > STALE_MS) {
            try {
                await fs.promises.unlink(full);
            }
            catch { /* ignore */ }
            continue;
        }
        out.push(data);
    }
    return out;
}
/**
 * Delete a file we could not make sense of — but only once it is old enough to be certainly dead.
 *
 * Age-gated rather than deleted on sight. Writes are atomic now, so a fragment should no longer be
 * possible; if one appears anyway it is more likely a window mid-recovery than a leak, and deleting
 * a live window's entry would make it invisible to every other window until its next 60-second
 * publish. Waiting costs nothing: an unparsable file is skipped in the meantime either way.
 */
async function unlinkIfStale(full, now) {
    try {
        const stat = await fs.promises.stat(full);
        if (now - stat.mtimeMs <= STALE_MS) {
            return;
        }
        await fs.promises.unlink(full);
    }
    catch { /* vanished, or not ours to delete */ }
}
