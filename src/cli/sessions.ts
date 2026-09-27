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

import * as os from 'os';
import { discoverPeers } from '../remote/PeerDiscovery';
import { RemoteSessionSource, type PeerStatus } from '../remote/RemoteSessionSource';
import { SshRunner } from '../remote/SshRunner';
import {
  defaultStorePaths,
  parseSessionFile,
  scanBobSessions,
  scanChatSessions,
  scanClaudeSessions,
  scanCodexSessions,
  type ClaudeSession,
  type SessionStorePaths,
} from '../sessionScan';
import { isBlockedOnYou } from '../sessionStatus';
import { readLiveWindows } from '../WindowRegistry';
import { daemonClaimantFrom, resolveOwners, type Ownership } from '../telegram/ownership';
import { health, heartbeatPath, readHeartbeat } from '../daemonHeartbeat';


export interface CollectOptions {
  /** Store locations; defaulted so callers only override them in tests. */
  paths?: SessionStorePaths;
  /**
   * Pull sessions from peer machines over SSH.
   *
   * Off unless asked. Peer discovery is a local file read, but the pull that follows it opens SSH
   * connections, and a command that reaches the network without being told to is a command people
   * stop running. `--peers` is the consent.
   */
  peers?: boolean;
  /** Injected in tests, so no test ever opens a connection. */
  remote?: RemoteReader;
  /**
   * Also resolve what is responsible for each session — a VS Code window, the daemon, or nothing.
   *
   * Off unless asked because it reads two more places (the window registry and the daemon heartbeat)
   * for a column most invocations do not print. It is host-free: the window registry is a directory of
   * JSON files, so a terminal can answer this without an IDE, and answers it the same way the panel
   * does.
   */
  owners?: boolean;
}

/**
 * Why the terminal never reports `seen`.
 *
 * `resolveDisplayStatus` splits `finished` into `finished` / `seen` / `dormant` using when you last
 * opened the row, and that timestamp lives in the extension's `globalState`
 * (`sessionSitter.lastViewed`, inside VS Code's own `state.vscdb`) — not in any agent's store. So the
 * CLI reports the base state the transcript supports, and a read and an unread result both read
 * `finished` here.
 *
 * ponytail: not worth opening that db on every invocation — the two states it would unlock, `seen`
 * and an aged-out `dormant`, both mean "nothing for you to do", so neither changes the worklist. If
 * it ever matters, `PeerDiscovery` already reads that exact file and its reader can be reused.
 */

/** The part of `RemoteSessionSource` this module uses, so tests can stand in for it. */
export interface RemoteReader {
  refresh(): Promise<void>;
  getSessions(): ClaudeSession[];
  getPeerStatuses(): PeerStatus[];
}

export interface Worklist {
  sessions: ClaudeSession[];
  peers: PeerStatus[];
  /** Set when peers were asked for and the pull failed outright, rather than per-peer. */
  peerError?: string;
  /** Present only when `owners` was asked for. Keyed by session id. */
  owners?: Map<string, Ownership>;
}

/**
 * Scan every source and return the merged list, newest first.
 *
 * Sources are read in sequence, as `_scanSessions` reads them: they are all local file work, and a
 * failing source already returns an empty list rather than throwing.
 */
export async function collectSessions(opts: CollectOptions = {}): Promise<Worklist> {
  const paths = opts.paths ?? defaultStorePaths();
  const sessions = [
    ...(await scanClaudeSessions(paths.projectsDir, new Map(), new Map(), paths.vscodeUserDir)),
    ...(await scanBobSessions(paths.bobDbPath)),
    ...(await scanCodexSessions(paths.codexSessionsDir, paths.codexIndexPath)),
    ...(await scanChatSessions(paths.vscodeUserDir)),
  ];

  const result: Worklist = { sessions, peers: [] };
  if (!opts.peers && !opts.remote) {
    result.sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (opts.owners) { result.owners = await resolveOwnership(result.sessions); }
    return result;
  }

  const remote = opts.remote ?? new RemoteSessionSource({
    runner: new SshRunner(),
    discover: () => discoverPeers(),
    // The real parser, so a peer's session is titled by exactly the code that titles a local one.
    parseSessionFile,
  });
  try {
    await remote.refresh();
    result.sessions.push(...remote.getSessions());
    result.peers = remote.getPeerStatuses();
  } catch (err) {
    // One unreachable peer must never cost you the local worklist — the same rule the panel keeps.
    result.peerError = String(err);
  }
  result.sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  if (opts.owners) { result.owners = await resolveOwnership(result.sessions); }
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
async function resolveOwnership(sessions: ClaudeSession[]): Promise<Map<string, Ownership>> {
  const windows = await readLiveWindows();
  const beat = await readHeartbeat(heartbeatPath());
  const daemon = daemonClaimantFrom(beat, health(beat, Date.now(), pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }));
  return resolveOwners(sessions, windows, daemon);
}

export interface FilterOptions {
  /** Drop sessions not updated since this instant. Undefined means no window. */
  since?: Date;
  /** Keep only this agent (`claude` | `bob` | `codex` | `chat`). */
  agent?: string;
  /**
   * Keep only sessions that are blocked on a human — `approval` and `question`.
   *
   * Not the wider `needsYou`, which also counts `finished`: an unread result is a reason to look,
   * but nothing is stalled waiting for you to look at it. `--needs-me` is a to-do list, so it is
   * the two states where the agent cannot proceed without you.
   */
  needsMe?: boolean;
}

export function filterSessions(
  sessions: readonly ClaudeSession[], opts: FilterOptions,
): ClaudeSession[] {
  return sessions.filter(s => {
    if (opts.since && s.updatedAt.getTime() < opts.since.getTime()) { return false; }
    if (opts.agent && s.source !== opts.agent) { return false; }
    if (opts.needsMe && !isBlockedOnYou(s.status)) { return false; }
    return true;
  });
}

/** This machine's short name, for the column that says where a session lives. */
export function localHost(): string {
  return os.hostname().split('.')[0];
}

/** A peer's short name, matching how `sessionSort` keys the same field. */
export function peerHost(peer: string): string {
  return peer.split('@').pop()?.split('.')[0] ?? peer;
}
