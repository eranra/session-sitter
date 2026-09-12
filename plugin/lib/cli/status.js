// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/status.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * `session-sitter status` — the worklist, in the terminal.
 *
 * The one screen this whole command exists for: every session across Claude Code, IBM Bob, Codex
 * and VS Code Chat, on this machine and on peers, ordered so the ones waiting on a human are the
 * ones you read first.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseStatusArgs = exports.HELP = void 0;
exports.renderText = renderText;
exports.renderJson = renderJson;
exports.run = run;
const sessionSort_1 = require("../sessionSort");
const sessionStatus_1 = require("../sessionStatus");
const sessions_1 = require("./sessions");
const ownership_1 = require("../telegram/ownership");
const args_1 = require("./args");
const time_1 = require("./time");
const render_1 = require("./render");
/**
 * What is responsible for a session, in one column.
 *
 * The distinction the column exists to draw is not "who" but **what can be done**: an IDE window can
 * have text written into it, and the daemon cannot — it mirrors the session and answers the permission
 * prompts it raises. Printing both as a pid would hide the only difference that matters.
 */
function ownerLabel(owner, paint) {
    if (owner === undefined || owner.pid === null) {
        return paint('read-only', 'dim');
    }
    return owner.basis === 'daemon'
        ? paint(`daemon ${owner.pid}`, 'dim')
        : `window ${owner.pid}`;
}
/** Every order `--sort` accepts — the same six the panel's sort menu offers. */
const SORT_MODES = sessionSort_1.SESSION_SORT_MODES.map(m => m.id);
/**
 * The default order: `status`, which `sessionSort` ranks by urgency — approval, question,
 * finished, working, seen, dormant. That is the worklist order, so the terminal does not need one
 * of its own.
 */
const DEFAULT_SORT = 'status';
exports.HELP = `session-sitter status — every agent session, and which of them need you

Usage:
  session-sitter status [options]

Options:
  --since WHEN        only sessions updated since WHEN (default: 24h)
                      WHEN is 2h, 45m, yesterday, 2026-08-30, or an ISO timestamp
  --all               no time window — every session on disk, however old
  --agent NAME        only claude, bob, codex or chat
  --needs-me          only sessions whose turn it is for a human
  --sort MODE         ${SORT_MODES.join(', ')}
                      (default: ${DEFAULT_SORT} — most urgent first)
  --peers             also pull sessions from peer machines over SSH
  --watch [SECONDS]   redraw in place every SECONDS (default: 5); Ctrl-C to stop
  --owners            add a column naming what is responsible for each session
  --json              machine-readable output (see docs/CLI.md for the contract)
  -h, --help          show this help

Statuses, most urgent first (docs/STATUS-INDICATORS.md has the full rules):
  approval    paused on a permission prompt — your yes/no unblocks it
  question    asked you something — needs an answer typed
  finished    done, and you have not opened it since
  working     running a tool or writing a reply — nothing for you to do
  seen        done, and you have read it
  dormant     nothing happening, or no signal to tell

--needs-me keeps approval and question: the two states where nothing moves until you act.
`;
const SPEC = {
    '--since': 'string',
    '--all': 'boolean',
    '--agent': 'string',
    '--needs-me': 'boolean',
    '--sort': 'string',
    '--peers': 'boolean',
    '--watch': 'optionalNumber',
    '--owners': 'boolean',
    '--json': 'boolean',
    '--help': 'boolean',
    '-h': 'boolean',
};
const AGENTS = {
    claude: 'Claude', bob: 'Bob', codex: 'Codex', chat: 'Chat',
};
/**
 * One marker per state, matching `docs/STATUS-INDICATORS.md` in meaning and in urgency order.
 *
 * A distinct glyph per state, not merely a distinct colour, for the same reason the panel uses
 * distinct shapes: colour is the first thing a terminal theme overrides and the first thing a
 * colour-blind reader loses, and `NO_COLOR` drops it entirely. Keyed by every state, so a seventh
 * fails to compile here rather than rendering blank.
 */
const INDICATOR = {
    approval: { glyph: '!', label: 'approval', color: 'yellow' },
    question: { glyph: '?', label: 'question', color: 'yellow' },
    finished: { glyph: '◉', label: 'finished', color: 'green' },
    working: { glyph: '▸', label: 'working', color: 'cyan' },
    // Red, alone among the states, because it is the only one reporting something *wrong* — a rate
    // limit or an outage. Not amber: amber is reserved for "your turn", and a stall is not your turn.
    stalled: { glyph: '⏸', label: 'stalled', color: 'red' },
    seen: { glyph: '·', label: 'seen', color: 'gray' },
    dormant: { glyph: '○', label: 'dormant', color: 'gray' },
};
const DEFAULT_WINDOW = '24h';
const DEFAULT_WATCH_SECONDS = 5;
const MIN_WATCH_SECONDS = 1;
function parse(argv, io) {
    const args = (0, args_1.parseFlags)(argv, SPEC);
    if (args.positional.length > 0) {
        throw new args_1.CliError(`status takes no arguments, got "${args.positional[0]}"`);
    }
    const sinceFlag = (0, args_1.flagString)(args, '--since');
    const all = (0, args_1.flagBool)(args, '--all');
    if (all && sinceFlag !== undefined) {
        throw new args_1.CliError('--all and --since contradict each other; pick one');
    }
    const sort = (0, args_1.flagString)(args, '--sort') ?? DEFAULT_SORT;
    if (!(0, sessionSort_1.isSessionSortMode)(sort)) {
        throw new args_1.CliError(`unknown --sort "${sort}" — one of ${SORT_MODES.join(', ')}`);
    }
    const agent = (0, args_1.flagString)(args, '--agent')?.toLowerCase();
    if (agent !== undefined && AGENTS[agent] === undefined) {
        throw new args_1.CliError(`unknown --agent "${agent}" — one of ${Object.keys(AGENTS).join(', ')}`);
    }
    const options = {
        agent,
        needsMe: (0, args_1.flagBool)(args, '--needs-me'),
        sort,
        peers: (0, args_1.flagBool)(args, '--peers'),
        owners: (0, args_1.flagBool)(args, '--owners'),
        json: (0, args_1.flagBool)(args, '--json'),
    };
    if (!all) {
        options.since = (0, time_1.parseSince)(sinceFlag ?? DEFAULT_WINDOW, io.now());
    }
    if (args.flags['--watch'] !== undefined) {
        if (options.json) {
            throw new args_1.CliError('--watch and --json cannot be combined');
        }
        // Redrawing in place needs a screen to redraw. Into a pipe or a file the escapes would be
        // garbage and the frames would append forever, so refuse instead of producing that.
        if (!io.isTty) {
            throw new args_1.CliError('--watch needs a terminal; stdout is not one');
        }
        const seconds = (0, args_1.flagNumber)(args, '--watch') ?? DEFAULT_WATCH_SECONDS;
        if (seconds < MIN_WATCH_SECONDS) {
            throw new args_1.CliError(`--watch needs at least ${MIN_WATCH_SECONDS} second`);
        }
        options.watchSeconds = seconds;
    }
    return options;
}
/** The rows, filtered and ordered, plus the peer reachability the JSON reports alongside them. */
async function worklist(options, collect) {
    const source = await collect({ peers: options.peers, owners: options.owners });
    const filtered = (0, sessions_1.filterSessions)(source.sessions, {
        since: options.since, agent: options.agent, needsMe: options.needsMe,
    });
    return { sessions: (0, sessionSort_1.sortSessions)(filtered, options.sort), source };
}
// ── Plain text ──────────────────────────────────────────────────────────────
/** How many sessions are in each state. Every state is present, at zero if need be. */
function counts(sessions) {
    const tally = Object.fromEntries(sessionStatus_1.SESSION_STATUSES.map(s => [s, 0]));
    for (const s of sessions) {
        tally[s.status] += 1;
    }
    return tally;
}
function summary(sessions, options, paint, now) {
    const tally = counts(sessions);
    const window = options.since ? `updated in the last ${(0, time_1.humanAge)(options.since, now)}` : 'all time';
    const blocked = tally.approval + tally.question;
    // Only the states actually present are named. Listing all six with four zeroes reads as noise,
    // and the count that matters is the one you have to act on.
    const parts = [
        `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
        paint(`${blocked} blocked on you`, blocked > 0 ? 'yellow' : 'dim'),
        ...sessionStatus_1.SESSION_STATUSES
            .filter(s => !(0, sessionStatus_1.isBlockedOnYou)(s) && tally[s] > 0)
            .map(s => `${tally[s]} ${s}`),
    ];
    return `${parts.join(paint(' · ', 'dim'))}${paint(`  (${window})`, 'dim')}`;
}
function renderText(sessions, source, options, io) {
    const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
    const now = io.now();
    const showMachine = sessions.some(s => s.peer) || source.peers.length > 0;
    const owners = source.owners;
    const lines = [summary(sessions, options, paint, now), ''];
    if (sessions.length === 0) {
        lines.push(paint('No sessions match. Try --all, a wider --since, or drop --needs-me.', 'dim'));
    }
    else {
        const columns = [
            { header: '' },
            { header: 'STATUS' },
            { header: 'SESSION', max: Math.max(24, Math.min(56, io.columns - 60)) },
            { header: 'AGENT' },
            { header: 'WORKSPACE', max: 24 },
            ...(showMachine ? [{ header: 'MACHINE' }] : []),
            ...(owners !== undefined ? [{ header: 'OWNER' }] : []),
            { header: 'UPDATED', right: true },
        ];
        const here = (0, sessions_1.localHost)();
        const rows = sessions.map(s => {
            const indicator = INDICATOR[s.status] ?? INDICATOR.dormant;
            return [
                paint(indicator.glyph, indicator.color),
                paint(indicator.label, indicator.color),
                s.title || paint('(untitled)', 'dim'),
                AGENTS[s.source] ?? s.source,
                s.projectName || paint('(no workspace)', 'dim'),
                ...(showMachine ? [s.peer ? (0, sessions_1.peerHost)(s.peer) : paint(here, 'dim')] : []),
                ...(owners !== undefined
                    ? [ownerLabel(owners.get(s.sessionId), paint)] : []),
                (0, time_1.humanAge)(s.updatedAt, now),
            ];
        });
        lines.push((0, render_1.table)(columns, rows, paint));
    }
    for (const peer of source.peers) {
        lines.push(peer.reachable
            ? paint(`peer ${(0, sessions_1.peerHost)(peer.peer)}: ${peer.sessionCount ?? 0} sessions`, 'dim')
            : paint(`peer ${(0, sessions_1.peerHost)(peer.peer)}: unreachable — ${peer.error ?? 'no reason given'}`, 'red'));
    }
    if (source.peerError) {
        lines.push(paint(`peers could not be pulled: ${source.peerError}`, 'red'));
    }
    if (!options.peers) {
        lines.push('', paint('Peer machines not included. Add --peers to pull them over SSH.', 'dim'));
    }
    return `${lines.join('\n')}\n`;
}
/** One session's owner, in the `--json` shape. Null when nothing on this machine claims it. */
function ownerJson(owner) {
    if (owner === undefined || owner.pid === null) {
        return null;
    }
    return {
        kind: owner.basis === 'daemon' ? 'daemon' : 'window',
        pid: owner.pid,
        basis: owner.basis,
        // The field that matters, and computed once here rather than at each call site: a daemon owns the
        // session and still cannot have text written into it.
        canWrite: (0, ownership_1.canInject)(owner),
    };
}
function renderJson(sessions, source, now) {
    const here = (0, sessions_1.localHost)();
    return {
        version: 1,
        generatedAt: now.toISOString(),
        host: here,
        counts: { total: sessions.length, ...counts(sessions) },
        sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            agent: s.source,
            title: s.title,
            workspace: { name: s.projectName, path: s.projectPath },
            machine: s.peer ? (0, sessions_1.peerHost)(s.peer) : here,
            local: !s.peer,
            status: s.status,
            blockedOnYou: (0, sessionStatus_1.isBlockedOnYou)(s.status),
            updatedAt: s.updatedAt.toISOString(),
            ageSeconds: Math.max(0, Math.round((now.getTime() - s.updatedAt.getTime()) / 1000)),
            // Additive, and present only when it was asked for: a consumer written against version 1 before
            // this existed reads every other key unchanged, and one that did not pass `--owners` sees no
            // key rather than a null it might read as "nothing claims it".
            ...(source.owners !== undefined ? { owner: ownerJson(source.owners.get(s.sessionId)) } : {}),
        })),
        peers: source.peers.map(p => ({
            peer: p.peer,
            reachable: p.reachable,
            sessionCount: p.sessionCount ?? null,
            error: p.error ?? null,
        })),
    };
}
/**
 * Sleep between frames, but wake the instant Ctrl-C arrives.
 *
 * Without the wake, the refresh interval would also be the interrupt latency: Ctrl-C during
 * `--watch 60` would appear to do nothing for up to a minute, and the cursor would stay hidden for
 * just as long. The signal handler is handed `wake` and calls it.
 *
 * The timer is deliberately **not** unref'd. It is the only thing holding the event loop open
 * between frames, and unref'ing it exits the process after the first draw — with the cleanup in
 * `watch` never reached, so the terminal is left without a cursor.
 */
function interruptibleSleep(ms, register) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        register(() => { clearTimeout(timer); resolve(); });
    });
}
async function run(argv, io, collect = sessions_1.collectSessions) {
    const args = (0, args_1.parseFlags)(argv, SPEC);
    if ((0, args_1.flagBool)(args, '--help') || (0, args_1.flagBool)(args, '-h')) {
        io.out(exports.HELP);
        return 0;
    }
    const options = parse(argv, io);
    if (options.json) {
        const { sessions, source } = await worklist(options, collect);
        io.out(`${JSON.stringify(renderJson(sessions, source, io.now()), null, 2)}\n`);
        return 0;
    }
    if (options.watchSeconds === undefined) {
        const { sessions, source } = await worklist(options, collect);
        io.out(renderText(sessions, source, options, io));
        return 0;
    }
    return watch(options, io, collect);
}
/**
 * Redraw the worklist in place until Ctrl-C.
 *
 * Interrupt-clean is the whole requirement here: the cursor is hidden while drawing and restored on
 * the way out, whichever way we leave — including a scan that throws — so an interrupted watch
 * never leaves the terminal without a cursor.
 */
async function watch(options, io, collect) {
    let stopped = false;
    // Set while a frame's sleep is pending, so an interrupt cuts the sleep short instead of waiting
    // it out.
    let wake;
    const stop = () => { stopped = true; wake?.(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    io.out(render_1.HIDE_CURSOR);
    try {
        while (!stopped) {
            const { sessions, source } = await worklist(options, collect);
            if (stopped) {
                break;
            }
            const paint = (0, render_1.painter)((0, render_1.colorEnabled)(io));
            io.out(render_1.CLEAR_SCREEN
                + renderText(sessions, source, options, io)
                + paint(`\nrefreshing every ${options.watchSeconds}s — Ctrl-C to stop\n`, 'dim'));
            await interruptibleSleep(options.watchSeconds * 1000, w => { wake = w; });
            wake = undefined;
        }
    }
    finally {
        io.out(`${render_1.SHOW_CURSOR}\n`);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
    return 0;
}
/** Exported for the tests, which drive the parser directly rather than through a real terminal. */
exports.parseStatusArgs = parse;
