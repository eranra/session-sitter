// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/sessions.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Collecting the worklist for the terminal: every session, from every source, on every machine.
 *
 * This is the CLI's counterpart to `SessionManager._scanSessions` and it deliberately shares that
 * method's readers (`sessionScan`) rather than its structure. The extension holds a live cache and
 * a watcher; a CLI process runs once and exits, so it scans, reports and is gone.
 *
 * ## Why sessions are windowed by default
 *
 * `~/.claude/projects` is append-only and never pruned — a machine that has been in use for a
 * month holds hundreds of finished sessions. The panel hides the old ones behind process liveness;
 * a bare `session-sitter status` cannot, because that liveness check covers only sessions started
 * from the IDE and is currently broken on macOS. So the window is what keeps the worklist a
 * worklist, and `--all` is there for when you want the archive.
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
exports.collectSessions = collectSessions;
exports.filterSessions = filterSessions;
exports.localHost = localHost;
exports.peerHost = peerHost;
const os = __importStar(require("os"));
const PeerDiscovery_1 = require("../remote/PeerDiscovery");
const RemoteSessionSource_1 = require("../remote/RemoteSessionSource");
const SshRunner_1 = require("../remote/SshRunner");
const sessionScan_1 = require("../sessionScan");
const sessionStatus_1 = require("../sessionStatus");
const WindowRegistry_1 = require("../WindowRegistry");
const ownership_1 = require("../telegram/ownership");
const daemonHeartbeat_1 = require("../daemonHeartbeat");
/**
 * Scan every source and return the merged list, newest first.
 *
 * Sources are read in sequence, as `_scanSessions` reads them: they are all local file work, and a
 * failing source already returns an empty list rather than throwing.
 */
async function collectSessions(opts = {}) {
    const paths = opts.paths ?? (0, sessionScan_1.defaultStorePaths)();
    const sessions = [
        ...(await (0, sessionScan_1.scanClaudeSessions)(paths.projectsDir, new Map(), new Map(), paths.vscodeUserDir)),
        ...(await (0, sessionScan_1.scanBobSessions)(paths.bobDbPath)),
        ...(await (0, sessionScan_1.scanCodexSessions)(paths.codexSessionsDir, paths.codexIndexPath)),
        ...(await (0, sessionScan_1.scanChatSessions)(paths.vscodeUserDir)),
    ];
    const result = { sessions, peers: [] };
    if (!opts.peers && !opts.remote) {
        result.sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        if (opts.owners) {
            result.owners = await resolveOwnership(result.sessions);
        }
        return result;
    }
    const remote = opts.remote ?? new RemoteSessionSource_1.RemoteSessionSource({
        runner: new SshRunner_1.SshRunner(),
        discover: () => (0, PeerDiscovery_1.discoverPeers)(),
        // The real parser, so a peer's session is titled by exactly the code that titles a local one.
        parseSessionFile: sessionScan_1.parseSessionFile,
    });
    try {
        await remote.refresh();
        result.sessions.push(...remote.getSessions());
        result.peers = remote.getPeerStatuses();
    }
    catch (err) {
        // One unreachable peer must never cost you the local worklist — the same rule the panel keeps.
        result.peerError = String(err);
    }
    result.sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (opts.owners) {
        result.owners = await resolveOwnership(result.sessions);
    }
    return result;
}
/**
 * Who is responsible for each session, resolved exactly as the panel resolves it.
 *
 * Host-free on purpose: the window registry is a directory of JSON files and the heartbeat is one more,
 * so a terminal reaches the same answer as an IDE without being one. Sharing `resolveOwners` rather
 * than reimplementing it is what stops the two surfaces disagreeing about who holds a session — which
 * is worse than either being wrong, because then neither can be trusted.
 */
async function resolveOwnership(sessions) {
    const windows = await (0, WindowRegistry_1.readLiveWindows)();
    const beat = await (0, daemonHeartbeat_1.readHeartbeat)((0, daemonHeartbeat_1.heartbeatPath)());
    const daemon = (0, ownership_1.daemonClaimantFrom)(beat, (0, daemonHeartbeat_1.health)(beat, Date.now(), pid => {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }));
    return (0, ownership_1.resolveOwners)(sessions, windows, daemon);
}
function filterSessions(sessions, opts) {
    return sessions.filter(s => {
        if (opts.since && s.updatedAt.getTime() < opts.since.getTime()) {
            return false;
        }
        if (opts.agent && s.source !== opts.agent) {
            return false;
        }
        if (opts.needsMe && !(0, sessionStatus_1.isBlockedOnYou)(s.status)) {
            return false;
        }
        return true;
    });
}
/** This machine's short name, for the column that says where a session lives. */
function localHost() {
    return os.hostname().split('.')[0];
}
/** A peer's short name, matching how `sessionSort` keys the same field. */
function peerHost(peer) {
    return peer.split('@').pop()?.split('.')[0] ?? peer;
}
