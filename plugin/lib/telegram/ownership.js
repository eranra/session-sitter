// GENERATED FILE — DO NOT EDIT.
// Compiled from src/telegram/ownership.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Which VS Code window is responsible for a session.
 *
 * The rule the whole remote-control feature rests on: **one window owns a session, and only its
 * owner may write to it.** Everything else — routing a Telegram message, starting a session,
 * refusing to guess — is a consequence.
 *
 * ## Why not match on workspace path alone
 *
 * The obvious rule ("the window whose workspace is the session's cwd") is wrong in cases this
 * repository creates on purpose:
 *
 *  - A worktree session's cwd is `<repo>/.claude/worktrees/<name>` — a *subdirectory* of the
 *    window's workspace, so equality misses it.
 *  - Two windows can be open on the same folder, and both would claim.
 *  - A history session's workspace may have no window open at all.
 *
 * So the claim is decided in tiers, strongest first:
 *
 *  1. **Holds it.** The window's live agent state lists this session (`openClaudeSessionIds`,
 *     `openBobTaskIds` in the window registry). Exact, no heuristics, and it is what makes a
 *     write land in the right place.
 *  2. **Longest workspace prefix.** No window holds it, so the window whose workspace folder is
 *     the longest prefix of the session's `projectPath` claims it. Covers idle and history
 *     sessions. Ties break on lowest pid so every window computes the same answer.
 *  3. **The daemon**, when one is running here. On a machine with no VS Code at all the first two
 *     tiers find nothing, so every session was read-only and a terminal-only fleet could be neither
 *     listed nor answered. `session-sitter daemon` claims what no window does.
 *  4. **Nobody.** The session is read-only. This is reported, never silently swallowed.
 *
 * ## An owner is not automatically able to write
 *
 * The tiers above are about *responsibility*; {@link canInject} is about *capability*, and they are
 * not the same question. Injecting text into a session goes through the agent's own extension host
 * over the V8 inspector, which exists only inside VS Code — so a daemon can own a session, mirror it,
 * and answer the permission prompts it raises, and still be unable to type into it.
 *
 * Keeping those apart is what stops the remote interface offering a button that silently does nothing.
 * The rule this feature rests on is that it never writes to a session it cannot positively reach, and
 * says why where it cannot; an owner flag that conflated the two would quietly break that.
 *
 * Every function here is pure — the registry and the daemon are passed in — so the rule is
 * unit-testable without a live IDE, which the inspector-based write paths never are.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNOWNED = void 0;
exports.canInject = canInject;
exports.ownedByAWindow = ownedByAWindow;
exports.injectionBlocker = injectionBlocker;
exports.heldSessionIds = heldSessionIds;
exports.pathContains = pathContains;
exports.resolveOwner = resolveOwner;
exports.daemonClaimantFrom = daemonClaimantFrom;
exports.resolveOwners = resolveOwners;
exports.ownedByThisWindow = ownedByThisWindow;
exports.isWritableSource = isWritableSource;
exports.writeBlockedReason = writeBlockedReason;
exports.UNOWNED = { pid: null, basis: 'none', workspace: '' };
/**
 * Whether text can be written into a session with this owner.
 *
 * Only a window can, and only through the agent's own extension host over the V8 inspector. A daemon
 * cannot type into a terminal session — it can mirror it, list it, and answer the permission prompts it
 * raises through hook escalation, which is a different and narrower power.
 *
 * `workspace` counts because that window is running and its inspector is reachable; whether the *right*
 * channel can be identified inside it is a separate refusal `ClaudeSender` makes for itself.
 */
function canInject(owner) {
    return owner.basis === 'holds' || owner.basis === 'workspace';
}
/**
 * Whether some VS Code window — as opposed to the daemon, or nobody — currently owns this session.
 *
 * `RemoteControlService` runs only inside a window's extension host; the daemon claims sessions
 * (tier 3) but runs no mirror loop of its own. So a session whose owner fails this check is one no
 * running process is currently renaming or posting turns for on its own account — that gap is what
 * the reader's orphan sweep exists to close. Same shape as `canInject` today, but a different
 * question: this asks who is *responsible*, that asks who can *write*. They coincide only because
 * neither tier that fails this can reach an extension host.
 */
function ownedByAWindow(owner) {
    return owner.basis === 'holds' || owner.basis === 'workspace';
}
/** A sentence saying why this owner cannot be written to. Null when it can. */
function injectionBlocker(owner) {
    if (canInject(owner)) {
        return null;
    }
    if (owner.basis === 'daemon') {
        return 'the session-sitter daemon holds this session, not an IDE window. It can mirror the session '
            + 'and answer the permission prompts it raises, but writing text in needs the agent\'s own '
            + 'extension host, which only runs inside VS Code. Open the session in an IDE window to send it '
            + 'a message.';
    }
    return 'no window or daemon on this machine claims this session, so nothing here can write to it.';
}
/** Session ids a window holds live, across every agent it hosts. */
function heldSessionIds(entry) {
    return new Set([
        ...(entry.openClaudeSessionIds ?? []),
        ...(entry.openBobTaskIds ?? []),
    ]);
}
/**
 * True when `folder` contains `target` — the same path, or a parent directory of it.
 *
 * The separator check is what stops `/work/app` from claiming a session in `/work/app-legacy`.
 * Trailing separators are trimmed so a folder recorded as `/work/app/` behaves identically.
 */
function pathContains(folder, target) {
    const f = folder.replace(/[/\\]+$/, '');
    if (!f) {
        return false;
    }
    if (target === f) {
        return true;
    }
    return target.startsWith(f) && (target[f.length] === '/' || target[f.length] === '\\');
}
/** Length of the longest workspace folder of `entry` that contains `target`, or -1 for none. */
function prefixScore(entry, target) {
    let best = -1;
    for (const folder of entry.workspaceFolders) {
        if (pathContains(folder, target)) {
            const len = folder.replace(/[/\\]+$/, '').length;
            if (len > best) {
                best = len;
            }
        }
    }
    return best;
}
/**
 * Resolve the owner of one session against a snapshot of live windows.
 *
 * A session on another machine is never owned by a local window: `peer` set means the session
 * lives elsewhere, and only that machine's own windows can act on it.
 */
function resolveOwner(session, windows, daemon = null) {
    if (session.peer) {
        return exports.UNOWNED;
    }
    // Tier 1 — a window that actually holds the session. Lowest pid wins if (unusually) two do.
    const holders = windows
        .filter(w => heldSessionIds(w).has(session.sessionId))
        .sort((a, b) => a.pid - b.pid);
    if (holders.length > 0) {
        return { pid: holders[0].pid, basis: 'holds', workspace: holders[0].workspaceFolders[0] ?? '' };
    }
    // Tier 2 — longest containing workspace folder; lowest pid breaks a tie.
    let best;
    let bestScore = -1;
    for (const w of windows) {
        const score = prefixScore(w, session.projectPath);
        if (score < 0) {
            continue;
        }
        if (score > bestScore || (score === bestScore && best !== undefined && w.pid < best.pid)) {
            best = w;
            bestScore = score;
        }
    }
    if (best !== undefined) {
        return { pid: best.pid, basis: 'workspace', workspace: best.workspaceFolders[0] ?? '' };
    }
    // Tier 3 — the daemon, when one is running here.
    //
    // Below both window tiers rather than above them, and not because a window is more trustworthy: a
    // window can do strictly more. It can have text written into it, which the daemon cannot. Putting
    // the daemon first would take a session that could be answered from a phone and hand it to an owner
    // that can only watch.
    if (daemon !== null) {
        return { pid: daemon.pid, basis: 'daemon', workspace: '' };
    }
    // Tier 4 — read-only.
    return exports.UNOWNED;
}
/**
 * The daemon on this machine, if one is running and working, as a claimant.
 *
 * `running` and nothing else. A `stale` daemon — process alive, passes stopped — must not claim
 * anything: it would take sessions away from the read-only tier and then fail to mirror or answer them,
 * which is worse than nobody claiming them, because the list would say someone had.
 */
function daemonClaimantFrom(beat, health) {
    return beat !== null && health === 'running' ? { pid: beat.pid } : null;
}
/** Resolve owners for many sessions in one pass. Keyed by session id. */
function resolveOwners(sessions, windows, daemon = null) {
    return new Map(sessions.map(s => [s.sessionId, resolveOwner(s, windows, daemon)]));
}
/**
 * True when this process (by pid) is the one responsible for the session.
 *
 * Named for a window because that is what every existing caller is, and it answers the same question
 * for a daemon: both ask "is the owner me", and both pass their own pid.
 */
function ownedByThisWindow(session, windows, pid, daemon = null) {
    return resolveOwner(session, windows, daemon).pid === pid;
}
/**
 * Whether a session can be written to at all, before any agent-specific check.
 *
 * Codex and VS Code Chat expose no way to inject a message, so they are read-only however they
 * are owned. Reported up front rather than discovered as a failed send.
 */
function isWritableSource(source) {
    return source === 'bob' || source === 'claude';
}
/** Why a session cannot be written to, or null when it can. A user-facing sentence. */
function writeBlockedReason(session, owner) {
    if (session.peer) {
        return `This session runs on ${session.peer}. Configure a bot on that machine to control it.`;
    }
    if (!isWritableSource(session.source)) {
        const name = session.source === 'codex' ? 'Codex' : 'VS Code Chat';
        return `${name} has no message API, so this session is read-only.`;
    }
    if (owner.pid === null) {
        return 'No open window is responsible for this session, so nothing can write to it.';
    }
    // An owner that cannot inject is the daemon: responsible for the session, and unable to type into
    // it. Reported here so the topic header says so up front, rather than after someone has typed a
    // message and waited for it to land.
    return injectionBlocker(owner);
}
