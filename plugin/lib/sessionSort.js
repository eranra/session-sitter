// GENERATED FILE — DO NOT EDIT.
// Compiled from src/sessionSort.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * How the session list is ordered.
 *
 * The default — most recently updated first — is the right answer for "what did I touch last",
 * and the wrong answer for "where is the session I was just looking at". Under recency every
 * update reshuffles the rows, so a list you are reading moves under the cursor and you lose your
 * place. The alternatives here are stable: their keys are properties of the session (its machine,
 * its workspace, its title), not of the clock, so a row only moves when a session appears or
 * disappears.
 *
 * Every comparator is **total** — each one falls through to `sessionId` — which is what makes a
 * stable mode actually stable. A comparator that ties leaves the order to whatever sequence the
 * scan happened to produce, and that sequence changes between passes.
 *
 * Deliberately free of `vscode` and of any I/O, so it is pure and cheap to test.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_SORT_MODES = exports.DEFAULT_SESSION_SORT = void 0;
exports.isSessionSortMode = isSessionSortMode;
exports.toSessionSortMode = toSessionSortMode;
exports.sessionSortLabel = sessionSortLabel;
exports.sortSessions = sortSessions;
exports.DEFAULT_SESSION_SORT = 'recent';
/** Menu order, which is also the order the panel lists them in. */
exports.SESSION_SORT_MODES = [
    {
        id: 'recent',
        label: 'Recently updated',
        description: 'Newest activity first. Rows move as sessions update.',
        stable: false,
    },
    {
        id: 'hostWorkspace',
        label: 'Machine, then workspace',
        description: 'Groups by machine, then workspace, then title. Rows hold still.',
        stable: true,
    },
    {
        id: 'workspace',
        label: 'Workspace, then title',
        description: 'Groups by workspace regardless of machine. Rows hold still.',
        stable: true,
    },
    {
        id: 'source',
        label: 'Agent, then workspace',
        description: 'Groups Claude, Bob, Codex and Chat together. Rows hold still.',
        stable: true,
    },
    {
        id: 'title',
        label: 'Title (A to Z)',
        description: 'Alphabetical by session title. Rows hold still.',
        stable: true,
    },
    {
        id: 'status',
        label: 'Needs you first',
        description: 'Blocked on you, then unread, then working, then quiet — newest first in each group.',
        stable: false,
    },
];
const MODE_IDS = new Set(exports.SESSION_SORT_MODES.map(m => m.id));
function isSessionSortMode(value) {
    return typeof value === 'string' && MODE_IDS.has(value);
}
/** A stored or user-typed value, narrowed to a mode we can actually sort by. */
function toSessionSortMode(value) {
    return isSessionSortMode(value) ? value : exports.DEFAULT_SESSION_SORT;
}
/** The menu label for a mode, for anything that has to name the current order. */
function sessionSortLabel(mode) {
    const id = toSessionSortMode(mode);
    return exports.SESSION_SORT_MODES.find(m => m.id === id)?.label ?? id;
}
// ── Sort keys ───────────────────────────────────────────────────────────────
/**
 * Short machine name for a session on another machine, or '' for a local one.
 *
 * The empty string is not what orders these: `byHost` ranks local ahead of remote explicitly,
 * because "this machine" is the one place you can act without a hop. Encoding that rule as a
 * sentinel character inside the key would hide it from anyone reading the comparator chain.
 */
function hostKey(s) {
    if (!s.peer) {
        return '';
    }
    // Sort by the host, not user@host: the username is noise once you know the machine.
    return s.peer.split('@').pop()?.split('.')[0]?.toLowerCase() ?? s.peer.toLowerCase();
}
function workspaceKey(s) {
    return (s.projectName || '').toLowerCase();
}
function titleKey(s) {
    return (s.title || '').toLowerCase();
}
/**
 * Most actionable first: the two states your input unblocks, then a result you have not read, then
 * work in progress, then everything quiet.
 *
 * `approval` leads `question` because a blocked tool usually stalls a whole run, while a question
 * has at least already told you what it needs. Keyed by every state, so adding an eighth fails to
 * compile here rather than silently sorting last.
 */
const STATUS_RANK = {
    // `stalled` sorts just below `working`: both are live runs, and a stall is the one of the two worth
    // looking at — but it stays under `finished`, because a result you have not read is still a better
    // use of your attention than a rate limit that will clear itself.
    approval: 0, question: 1, finished: 2, working: 3, stalled: 4, seen: 5, dormant: 6,
};
function statusRank(s) {
    return STATUS_RANK[s.status] ?? STATUS_RANK.dormant;
}
/** Agent grouping order. Matches the badge order used elsewhere in the panel. */
const SOURCE_RANK = { claude: 0, bob: 1, codex: 2, chat: 3 };
function sourceRank(s) {
    return SOURCE_RANK[s.source] ?? 4;
}
function updatedMs(s) {
    const ms = s.updatedAt instanceof Date ? s.updatedAt.getTime() : new Date(s.updatedAt).getTime();
    return Number.isNaN(ms) ? 0 : ms;
}
/** Locale-independent string order, so the same list sorts identically on every machine. */
function cmpText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** Run comparators in order and return the first non-zero verdict. */
function chain(...comparators) {
    return (a, b) => {
        for (const cmp of comparators) {
            const verdict = cmp(a, b);
            if (verdict !== 0) {
                return verdict;
            }
        }
        return 0;
    };
}
const byRecency = (a, b) => updatedMs(b) - updatedMs(a);
// Local sessions as one group ahead of every peer, then peers by machine name.
const byHost = (a, b) => (a.peer ? 1 : 0) - (b.peer ? 1 : 0) || cmpText(hostKey(a), hostKey(b));
// A session with no workspace cannot be grouped with anything, so it trails rather than leading —
// which is where an empty name would otherwise put it.
const byWorkspace = (a, b) => (workspaceKey(a) ? 0 : 1) - (workspaceKey(b) ? 0 : 1) || cmpText(workspaceKey(a), workspaceKey(b));
const byTitle = (a, b) => cmpText(titleKey(a), titleKey(b));
const byStatus = (a, b) => statusRank(a) - statusRank(b);
const bySource = (a, b) => sourceRank(a) - sourceRank(b);
// The final tie-break, present in every mode: without it equal keys leave the order to the scan.
const bySessionId = (a, b) => cmpText(a.sessionId, b.sessionId);
const COMPARATORS = {
    recent: chain(byRecency, bySessionId),
    hostWorkspace: chain(byHost, byWorkspace, byTitle, bySessionId),
    workspace: chain(byWorkspace, byTitle, byHost, bySessionId),
    source: chain(bySource, byWorkspace, byTitle, bySessionId),
    title: chain(byTitle, byWorkspace, bySessionId),
    status: chain(byStatus, byRecency, bySessionId),
};
/**
 * Order sessions for display. Never mutates the input; an unknown mode falls back to the default
 * rather than throwing, because the value can come from a hand-edited setting.
 */
function sortSessions(sessions, mode = exports.DEFAULT_SESSION_SORT) {
    return [...sessions].sort(COMPARATORS[toSessionSortMode(mode)]);
}
