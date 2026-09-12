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

import type { SessionStatus } from './sessionStatus';

/** The subset of a session this module orders by. */
export interface SortableSession {
  sessionId: string;
  projectName: string;
  title: string;
  updatedAt: Date;
  status: SessionStatus;
  source: string;
  /** "user@host" when the session lives on another machine; absent means this one. */
  peer?: string;
}

export type SessionSortMode =
  | 'recent'
  | 'workspace'
  | 'hostWorkspace'
  | 'status'
  | 'source'
  | 'title';

export const DEFAULT_SESSION_SORT: SessionSortMode = 'recent';

/** One entry of the panel's sort menu. `label` is what the menu shows. */
export interface SessionSortOption {
  id: SessionSortMode;
  label: string;
  /** Why you would pick it — the menu item's tooltip. */
  description: string;
  /** Whether row positions hold still across refreshes. */
  stable: boolean;
}

/** Menu order, which is also the order the panel lists them in. */
export const SESSION_SORT_MODES: readonly SessionSortOption[] = [
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

const MODE_IDS: ReadonlySet<string> = new Set(SESSION_SORT_MODES.map(m => m.id));

export function isSessionSortMode(value: unknown): value is SessionSortMode {
  return typeof value === 'string' && MODE_IDS.has(value);
}

/** A stored or user-typed value, narrowed to a mode we can actually sort by. */
export function toSessionSortMode(value: unknown): SessionSortMode {
  return isSessionSortMode(value) ? value : DEFAULT_SESSION_SORT;
}

/** The menu label for a mode, for anything that has to name the current order. */
export function sessionSortLabel(mode: unknown): string {
  const id = toSessionSortMode(mode);
  return SESSION_SORT_MODES.find(m => m.id === id)?.label ?? id;
}

// ── Sort keys ───────────────────────────────────────────────────────────────

/**
 * Short machine name for a session on another machine, or '' for a local one.
 *
 * The empty string is not what orders these: `byHost` ranks local ahead of remote explicitly,
 * because "this machine" is the one place you can act without a hop. Encoding that rule as a
 * sentinel character inside the key would hide it from anyone reading the comparator chain.
 */
function hostKey(s: SortableSession): string {
  if (!s.peer) { return ''; }
  // Sort by the host, not user@host: the username is noise once you know the machine.
  return s.peer.split('@').pop()?.split('.')[0]?.toLowerCase() ?? s.peer.toLowerCase();
}

function workspaceKey(s: SortableSession): string {
  return (s.projectName || '').toLowerCase();
}

function titleKey(s: SortableSession): string {
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
const STATUS_RANK: Record<SessionStatus, number> = {
  // `stalled` sorts just below `working`: both are live runs, and a stall is the one of the two worth
  // looking at — but it stays under `finished`, because a result you have not read is still a better
  // use of your attention than a rate limit that will clear itself.
  approval: 0, question: 1, finished: 2, working: 3, stalled: 4, seen: 5, dormant: 6,
};

function statusRank(s: SortableSession): number {
  return STATUS_RANK[s.status] ?? STATUS_RANK.dormant;
}

/** Agent grouping order. Matches the badge order used elsewhere in the panel. */
const SOURCE_RANK: Record<string, number> = { claude: 0, bob: 1, codex: 2, chat: 3 };

function sourceRank(s: SortableSession): number {
  return SOURCE_RANK[s.source] ?? 4;
}

function updatedMs(s: SortableSession): number {
  const ms = s.updatedAt instanceof Date ? s.updatedAt.getTime() : new Date(s.updatedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** Locale-independent string order, so the same list sorts identically on every machine. */
function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Comparator = (a: SortableSession, b: SortableSession) => number;

/** Run comparators in order and return the first non-zero verdict. */
function chain(...comparators: Comparator[]): Comparator {
  return (a, b) => {
    for (const cmp of comparators) {
      const verdict = cmp(a, b);
      if (verdict !== 0) { return verdict; }
    }
    return 0;
  };
}

const byRecency: Comparator = (a, b) => updatedMs(b) - updatedMs(a);
// Local sessions as one group ahead of every peer, then peers by machine name.
const byHost: Comparator = (a, b) =>
  (a.peer ? 1 : 0) - (b.peer ? 1 : 0) || cmpText(hostKey(a), hostKey(b));
// A session with no workspace cannot be grouped with anything, so it trails rather than leading —
// which is where an empty name would otherwise put it.
const byWorkspace: Comparator = (a, b) =>
  (workspaceKey(a) ? 0 : 1) - (workspaceKey(b) ? 0 : 1) || cmpText(workspaceKey(a), workspaceKey(b));
const byTitle: Comparator = (a, b) => cmpText(titleKey(a), titleKey(b));
const byStatus: Comparator = (a, b) => statusRank(a) - statusRank(b);
const bySource: Comparator = (a, b) => sourceRank(a) - sourceRank(b);
// The final tie-break, present in every mode: without it equal keys leave the order to the scan.
const bySessionId: Comparator = (a, b) => cmpText(a.sessionId, b.sessionId);

const COMPARATORS: Record<SessionSortMode, Comparator> = {
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
export function sortSessions<T extends SortableSession>(
  sessions: readonly T[],
  mode: unknown = DEFAULT_SESSION_SORT,
): T[] {
  return [...sessions].sort(COMPARATORS[toSessionSortMode(mode)]);
}
