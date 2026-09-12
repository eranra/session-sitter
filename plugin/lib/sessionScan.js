// GENERATED FILE — DO NOT EDIT.
// Compiled from src/sessionScan.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Reading the four agents' session stores — the pure half of session detection.
 *
 * This module is deliberately free of `vscode`: it knows how to *find and parse* a session, and
 * nothing about how to *watch* for one. That split exists because there are now two front ends over
 * the same stores — the extension panel and the `session-sitter` terminal command — and a CLI
 * cannot import `vscode` at all. `SessionManager` keeps the file watchers, the debounced rescan and
 * the `ExtensionContext` wiring, and calls in here for every read.
 *
 * It does not decide what a session's status *means*, either. `readStatus` below does the I/O and
 * hands the records to `claudeStatusFromTail` in `sessionStatus.ts`, which owns every state and
 * every rule behind them. One copy of those rules, read by both front ends.
 *
 * Nothing here holds state, so every function takes the directory it reads as an argument. That is
 * also what makes the whole module testable against a temp directory.
 */
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
exports.vscodeUserDir = vscodeUserDir;
exports.liveSessionPids = liveSessionPids;
exports.getActiveSessionIds = getActiveSessionIds;
exports.defaultStorePaths = defaultStorePaths;
exports.scanClaudeSessions = scanClaudeSessions;
exports.scanBobSessions = scanBobSessions;
exports.scanCodexSessions = scanCodexSessions;
exports.scanChatSessions = scanChatSessions;
exports.readFirstLine = readFirstLine;
exports.readCodexIndex = readCodexIndex;
exports.findCodexRollouts = findCodexRollouts;
exports.findJsonlFiles = findJsonlFiles;
exports.parseSessionFile = parseSessionFile;
exports.readStatus = readStatus;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const util_1 = require("util");
const BobDatabase_1 = require("./BobDatabase");
const paths_1 = require("./hooks/paths");
const sessionRows_1 = require("./sessionRows");
const sessionStatus_1 = require("./sessionStatus");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * Directory holding VS Code's per-user state (`workspaceStorage/` lives here), where
 * VS Code Chat sessions are stored. Platform-specific; exported so it can be unit-tested
 * without a real home directory.
 *
 * Was macOS-only. Linux matters in practice: the supervision runtime targets WSL, where
 * `~/Library/…` does not exist and Chat sessions would silently never be found.
 */
function vscodeUserDir(homedir = os.homedir(), platform = process.platform) {
    if (platform === 'darwin') {
        return path.join(homedir, 'Library', 'Application Support', 'Code', 'User');
    }
    if (platform === 'win32') {
        return path.join(process.env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'), 'Code', 'User');
    }
    return path.join(homedir, '.config', 'Code', 'User');
}
const realProcessProbe = {
    signal: (pid) => { process.kill(pid, 0); },
    procStat: (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
    // One spawn for the whole worklist, because this runs on the 5-second poll. `ps` prints the
    // rows in its own order, hence asking for the PID alongside the start time.
    psStart: async (pids) => {
        const { stdout } = await execFileAsync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')]);
        const rows = stdout.split('\n').map(line => /^\s*(\d+)\s+(\S.*\S)/.exec(line));
        return new Map(rows.filter(m => m !== null).map(m => [Number(m[1]), m[2]]));
    },
};
/**
 * Whether a start time `ps` reported describes the same process start as the recorded `procStart`.
 *
 * Claude writes `procStart` in UTC while `ps` prints the machine's local zone, so on a host that
 * is not on UTC the two strings never match literally — comparing them as text is what made every
 * macOS session look dead. Both readings of the recorded string are therefore accepted. The cost
 * is that a recycled PID would also pass if its real start time were exactly the UTC offset away
 * from the recorded one, to the second; that coincidence is not worth more code to exclude.
 */
function startTimesAgree(procStart, psMs) {
    const asLocal = Date.parse(procStart);
    const asUtc = Date.parse(`${procStart} UTC`);
    return [asLocal, asUtc].some(ms => !Number.isNaN(ms) && Math.abs(ms - psMs) < 2000);
}
/**
 * Which of these PIDs are still the processes that recorded them — running, and not a different
 * process that happens to have inherited the PID.
 *
 * Takes the whole worklist rather than one PID at a time so the `ps` cross-check costs a single
 * spawn per poll. Exported for the tests; `platform` and `probe` are injected there.
 */
async function liveSessionPids(candidates, platform = process.platform, probe = realProcessProbe) {
    const running = candidates.filter(c => {
        try {
            probe.signal(c.pid);
            return true;
        }
        catch {
            return false;
        }
    });
    if (platform === 'linux') {
        // Field 21 of /proc/<pid>/stat is the kernel start time; a recycled PID gets a different one.
        return new Set(running.filter(c => {
            try {
                return String(c.procStart) === probe.procStat(c.pid).split(' ')[21];
            }
            catch {
                return false;
            }
        }).map(c => c.pid));
    }
    // No /proc here (macOS, Windows), so `ps` carries the only start time on offer. When it cannot
    // be run, or says nothing usable about a PID, fall back to the signal alone: losing the
    // PID-recycling guard is far better than losing every session, which is what reading /proc did.
    let starts = new Map();
    if (running.length > 0) {
        try {
            starts = await probe.psStart(running.map(c => c.pid));
        }
        catch { /* no usable `ps` on this host */ }
    }
    return new Set(running.filter(c => {
        const psMs = Date.parse(starts.get(c.pid)?.trim() ?? '');
        // No recorded procStart is no recycled-PID evidence either way, so the signal alone stands —
        // same fallback as when `ps` itself has nothing usable.
        return c.procStart === undefined || Number.isNaN(psMs) || startTimesAgree(String(c.procStart), psMs);
    }).map(c => c.pid));
}
// Read ~/.claude/sessions/*.json and return session IDs whose Claude process
// is still running. Each file stores the PID and the start-time (procStart) of
// the Claude process so we can distinguish a live session from a recycled PID.
// Only interactive VS Code sessions are included.
async function getActiveSessionIds() {
    const active = new Set();
    const sessionsDir = path.join((0, paths_1.claudeDir)(), 'sessions');
    let files;
    try {
        files = (await fs.promises.readdir(sessionsDir)).filter(f => f.endsWith('.json'));
    }
    catch {
        return active;
    }
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - DAY_MS;
    // Collected first, then checked in one pass: the `ps` cross-check below is a process spawn, and
    // this whole function runs on the 5-second poll.
    const candidates = [];
    for (const file of files) {
        try {
            const raw = await fs.promises.readFile(path.join(sessionsDir, file), 'utf8');
            const data = JSON.parse(raw);
            if (typeof data.pid !== 'number' || !data.sessionId) {
                continue;
            }
            if (data.entrypoint !== 'claude-vscode') {
                continue;
            }
            // Exclude processes started before the 24-hour window — these are
            // background sessions from a previous VS Code session that was never
            // properly closed, not sessions the user opened today.
            if (typeof data.startedAt === 'number' && data.startedAt < cutoff) {
                continue;
            }
            candidates.push({ pid: data.pid, procStart: data.procStart, sessionId: data.sessionId });
        }
        catch {
            // Malformed session file — skip
        }
    }
    const live = await liveSessionPids(candidates);
    for (const c of candidates) {
        if (live.has(c.pid)) {
            active.add(c.sessionId);
        }
    }
    return active;
}
// The most recent non-archived Bob tasks that have a first message.
const BOB_TASKS_SQL = 'SELECT id, project_id, title, status, first_message, created_at, updated_at, env '
    + 'FROM tasks WHERE time_archived IS NULL AND first_message IS NOT NULL '
    + 'ORDER BY updated_at DESC LIMIT 100';
/**
 * The default store locations. One definition, so the panel and the CLI never disagree about where
 * a session lives.
 */
function defaultStorePaths(homedir = os.homedir(), env = process.env) {
    return {
        // Claude's own store moves with CLAUDE_CONFIG_DIR. Bob, Codex and VS Code are separate tools
        // with separate configuration, and CLAUDE_CONFIG_DIR says nothing about where they keep theirs,
        // so relocating them on the strength of it would be inventing a convention.
        projectsDir: path.join((0, paths_1.claudeDir)(env, homedir), 'projects'),
        bobDbPath: path.join(homedir, '.bob', 'db', 'bob.db'),
        codexSessionsDir: path.join(homedir, '.codex', 'sessions'),
        codexIndexPath: path.join(homedir, '.codex', 'session_index.jsonl'),
        vscodeUserDir: vscodeUserDir(homedir),
    };
}
async function scanClaudeSessions(projectsDir, 
// Defaulted so each scanner is independently callable (unit tests drive them one at a
// time); `_scanSessions` always passes the maps it will swap in atomically.
filePaths = new Map(), sources = new Map()) {
    const sessions = [];
    const jsonlFiles = await findJsonlFiles(projectsDir);
    for (const filePath of jsonlFiles) {
        try {
            const session = await parseSessionFile(filePath);
            if (session !== null) {
                sessions.push(session);
                filePaths.set(session.sessionId, filePath);
                sources.set(session.sessionId, 'claude');
            }
        }
        catch {
            // Silently skip files that fail to parse
        }
    }
    return sessions;
}
async function scanBobSessions(bobDbPath, 
// Defaulted so each scanner is independently callable (unit tests drive them one at a
// time); `_scanSessions` always passes the maps it will swap in atomically.
filePaths = new Map(), sources = new Map()) {
    // Bob IDE stores its sessions in SQLite; `queryBobDb` is the single read-only shim.
    let rows;
    try {
        rows = await (0, BobDatabase_1.queryBobDb)(bobDbPath, BOB_TASKS_SQL);
    }
    catch {
        return []; // DB absent or python3 unavailable
    }
    const sessions = [];
    for (const row of rows) {
        try {
            // Shared with the remote path in `sessionRows.ts`, so a peer's row renders identically.
            const session = (0, sessionRows_1.bobRowToSession)(row);
            if (!session) {
                continue;
            }
            filePaths.set(session.sessionId, session.sessionId); // store id as key for lookup
            sources.set(session.sessionId, 'bob');
            sessions.push(session);
        }
        catch { /* skip malformed row */ }
    }
    return sessions;
}
// Codex CLI stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
// with an index at ~/.codex/session_index.jsonl mapping id -> {thread_name, updated_at}.
async function scanCodexSessions(codexSessionsDir, codexIndexPath, 
// Defaulted so each scanner is independently callable (unit tests drive them one at a
// time); `_scanSessions` always passes the maps it will swap in atomically.
filePaths = new Map(), sources = new Map()) {
    const index = await readCodexIndex(codexIndexPath);
    let rolloutFiles;
    try {
        rolloutFiles = await findCodexRollouts(codexSessionsDir);
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const filePath of rolloutFiles) {
        try {
            // Read line 0 (session_meta) only — Codex embeds long base_instructions
            // fields so line 0 can be well over 4 KB; must read progressively.
            const firstLine = await readFirstLine(filePath);
            if (!firstLine.trim()) {
                continue;
            }
            const record = JSON.parse(firstLine);
            if (record.type !== 'session_meta') {
                continue;
            }
            const sessionId = record.payload?.id;
            const cwd = record.payload?.cwd ?? '';
            if (!sessionId) {
                continue;
            }
            const idx = index.get(sessionId);
            const stat = await fs.promises.stat(filePath);
            const updatedAt = idx?.updatedAt ?? stat.mtime;
            const title = (idx?.threadName ?? (cwd ? path.basename(cwd) : '')).slice(0, 60);
            if (!title) {
                continue;
            }
            filePaths.set(sessionId, filePath);
            sources.set(sessionId, 'codex');
            sessions.push({
                sessionId,
                projectPath: cwd,
                projectName: cwd ? path.basename(cwd) : '',
                title,
                updatedAt,
                // Codex exposes no liveness signal of any kind — no extension host to ask, nothing in
                // the rollout that says whether it is mid-turn. 'dormant' is the honest answer, and its
                // tooltip says so rather than implying the session is finished.
                status: 'dormant',
                source: 'codex',
            });
        }
        catch { /* skip malformed rollout */ }
    }
    return sessions;
}
// Scan VS Code Chat sessions across all workspaces. Each workspaceStorage/<hash>
// may contain a chatSessions/*.jsonl plus a workspace.json that names the folder.
async function scanChatSessions(userDir, 
// Defaulted so each scanner is independently callable (unit tests drive them one at a
// time); `_scanSessions` always passes the maps it will swap in atomically.
filePaths = new Map(), sources = new Map()) {
    const wsRoot = path.join(userDir, 'workspaceStorage');
    let workspaceHashes;
    try {
        const entries = await fs.promises.readdir(wsRoot, { withFileTypes: true });
        workspaceHashes = entries.filter(e => e.isDirectory()).map(e => e.name);
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const hash of workspaceHashes) {
        const chatDir = path.join(wsRoot, hash, 'chatSessions');
        let chatFiles;
        try {
            const entries = await fs.promises.readdir(chatDir, { withFileTypes: true });
            chatFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(chatDir, e.name));
        }
        catch {
            continue;
        }
        // Resolve workspace folder path once per hash.
        let projectPath = '';
        let projectName = '(no workspace)';
        try {
            const wsMeta = await fs.promises.readFile(path.join(wsRoot, hash, 'workspace.json'), 'utf8');
            const parsed = JSON.parse(wsMeta);
            if (parsed.folder?.startsWith('file://')) {
                projectPath = decodeURIComponent(parsed.folder.slice('file://'.length));
                projectName = path.basename(projectPath) || '(no workspace)';
            }
        }
        catch { /* keep fallback */ }
        for (const filePath of chatFiles) {
            try {
                const firstLine = await readFirstLine(filePath);
                if (!firstLine.trim()) {
                    continue;
                }
                const rec = JSON.parse(firstLine);
                if (rec.kind !== 0) {
                    continue;
                }
                const sessionId = rec.v?.sessionId;
                if (!sessionId) {
                    continue;
                }
                const firstText = rec.v?.requests?.[0]?.message?.text?.trim();
                const title = (firstText && firstText.length > 0
                    ? firstText
                    : `Chat in ${projectName}`).slice(0, 60);
                const stat = await fs.promises.stat(filePath);
                filePaths.set(sessionId, filePath);
                sources.set(sessionId, 'chat');
                sessions.push({
                    sessionId,
                    projectPath,
                    projectName,
                    title,
                    updatedAt: stat.mtime,
                    // Same as Codex: no liveness signal to read, so we do not pretend to have one.
                    status: 'dormant',
                    source: 'chat',
                });
            }
            catch { /* skip malformed chat file */ }
        }
    }
    return sessions;
}
// Read a file's first line by reading progressively until we hit a newline
// or the cap. Used by scanners whose line 0 has an unbounded upper size —
// Codex rollouts routinely exceed 4 KB (embedded base_instructions); VS Code
// Chat snapshot lines can grow with long conversations. Cap defaults to 1 MB
// to catch malformed files without OOM.
async function readFirstLine(filePath, maxBytes = 1048576) {
    const CHUNK = 8192;
    const fd = await fs.promises.open(filePath, 'r');
    try {
        const chunks = [];
        let offset = 0;
        while (offset < maxBytes) {
            const buf = Buffer.alloc(CHUNK);
            const { bytesRead } = await fd.read(buf, 0, CHUNK, offset);
            if (bytesRead === 0) {
                break;
            }
            const chunk = buf.subarray(0, bytesRead).toString('utf8');
            const nl = chunk.indexOf('\n');
            if (nl >= 0) {
                chunks.push(chunk.slice(0, nl));
                return chunks.join('');
            }
            chunks.push(chunk);
            offset += bytesRead;
        }
        return chunks.join('');
    }
    finally {
        await fd.close();
    }
}
async function readCodexIndex(codexIndexPath) {
    const map = new Map();
    try {
        const raw = await fs.promises.readFile(codexIndexPath, 'utf8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                const rec = JSON.parse(trimmed);
                if (rec.id && rec.thread_name && rec.updated_at) {
                    map.set(rec.id, { threadName: rec.thread_name, updatedAt: new Date(rec.updated_at) });
                }
            }
            catch { /* skip malformed line */ }
        }
    }
    catch { /* file may not exist */ }
    return map;
}
async function findCodexRollouts(root) {
    const results = [];
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            }
            else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
                try {
                    const st = await fs.promises.stat(full);
                    if (st.mtime.getTime() >= ninetyDaysAgo) {
                        results.push(full);
                    }
                }
                catch { /* skip */ }
            }
        }
    };
    await walk(root);
    return results;
}
async function findJsonlFiles(dir) {
    const results = [];
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'subagents') {
                results.push(...(await findJsonlFiles(fullPath)));
            }
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // Directory doesn't exist or isn't readable — return empty
    }
    return results;
}
async function parseSessionFile(filePath) {
    const sessionId = path.basename(filePath, '.jsonl');
    const stat = await fs.promises.stat(filePath);
    const updatedAt = stat.mtime;
    // VS Code plugin sessions can have large attachment records before the first
    // user message. Read in 16 KB chunks up to 256 KB, collecting:
    //   - firstUserText + projectPath  (from the first user record)
    //   - aiTitle                      (from the ai-title record Claude Code writes)
    // Use aiTitle as the display title when available — it matches what VS Code
    // shows in the editor tab — and fall back to the raw first user message.
    const CHUNK_SIZE = 16384;
    const MAX_BYTES = 262144;
    const fh = await fs.promises.open(filePath, 'r');
    try {
        let fileOffset = 0;
        let leftover = '';
        let firstUserText = null;
        let projectPath = '';
        let aiTitle = null;
        outer: while (fileOffset < MAX_BYTES) {
            const buf = Buffer.alloc(CHUNK_SIZE);
            const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, fileOffset);
            if (bytesRead === 0) {
                break;
            }
            fileOffset += bytesRead;
            const chunk = leftover + buf.subarray(0, bytesRead).toString('utf8');
            const lines = chunk.split('\n');
            leftover = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    const record = JSON.parse(trimmed);
                    if (record.type === 'user' && firstUserText === null) {
                        const content = record.message?.content;
                        let text = null;
                        if (typeof content === 'string' && content.trim().length > 0) {
                            text = content.trim();
                        }
                        else if (Array.isArray(content)) {
                            for (const block of content) {
                                const b = block;
                                if (block !== null &&
                                    typeof block === 'object' &&
                                    b.type === 'text' &&
                                    typeof b.text === 'string' &&
                                    (b.text ?? '').trim().length > 0) {
                                    text = (b.text ?? '').trim();
                                    break;
                                }
                            }
                        }
                        if (text !== null) {
                            firstUserText = text;
                            projectPath = typeof record.cwd === 'string' && record.cwd.length > 0
                                ? record.cwd : '';
                        }
                    }
                    if (record.type === 'ai-title' &&
                        typeof record.aiTitle === 'string' &&
                        record.aiTitle.trim().length > 0) {
                        aiTitle = record.aiTitle.trim();
                    }
                }
                catch {
                    // Malformed JSON line — skip
                }
            }
            // Stop once we have both pieces; ai-title appears shortly after the
            // first assistant reply so we never need to read far.
            if (firstUserText !== null && aiTitle !== null) {
                break outer;
            }
        }
        if (firstUserText === null) {
            return null;
        }
        const title = (aiTitle ?? firstUserText).slice(0, 60);
        const projectName = projectPath ? path.basename(projectPath) : '';
        const status = await readStatus(fh, stat.size, updatedAt);
        // The caller (_scanClaudeSessions) records the id->path/source mapping into the local
        // maps it swaps in atomically; parsing must not mutate the live shared maps.
        return { sessionId, projectName, projectPath, title, updatedAt, status, source: 'claude' };
    }
    finally {
        await fh.close();
    }
}
/**
 * Read the tail of a Claude transcript and hand it to the classifier.
 *
 * Split deliberately: this method does the I/O — how much of the file to read, how to survive a
 * partial line at the window's edge — and `claudeStatusFromTail` does the deciding. All six
 * states are then unit-testable without a transcript on disk, and the rules live in one file
 * next to Bob's, instead of buried in a private method here.
 */
async function readStatus(fh, fileSize, updatedAt) {
    // Nothing has been written yet, so there is nothing to claim about it.
    if (fileSize === 0) {
        return 'dormant';
    }
    const TAIL = 32768; // 32 KB covers large file-history-snapshot records
    const offset = Math.max(0, fileSize - TAIL);
    const size = fileSize - offset;
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, offset);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const records = [];
    for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        // The first line of the window is usually a fragment. Skipping unparsable lines is what
        // makes reading a fixed-size tail safe.
        try {
            records.push(JSON.parse(trimmed));
        }
        catch { /* partial line */ }
    }
    return (0, sessionStatus_1.claudeStatusFromTail)(records, updatedAt.getTime(), Date.now());
}
