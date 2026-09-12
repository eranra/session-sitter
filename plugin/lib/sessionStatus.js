// GENERATED FILE — DO NOT EDIT.
// Compiled from src/sessionStatus.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * What a session's status marker means, and every rule that decides it.
 *
 * There used to be three states — active / waiting / idle — and they were computed inline in
 * `SessionManager`. Three was too few in the wrong place: a session paused on a permission prompt
 * looked identical to one busily running tools (a spinning green ring), which is exactly backwards,
 * because that is the one state where nothing happens until you act. And "idle" meant both "the
 * agent finished, your turn" and "we have no way to tell", so it could not be trusted either way.
 *
 * So the vocabulary now answers one question — *whose turn is it, and why* — and lives here as
 * pure functions: no `vscode`, no filesystem, no clock of its own. Time always arrives as an
 * argument. That is what lets every state be unit-tested, and it keeps the rules in one file
 * instead of spread across the manager, the view provider and the exporter.
 *
 * The prose version of this file, for users, is `docs/STATUS-INDICATORS.md`. They must agree.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPACTION_WINDOW_MS = exports.API_RETRY_WINDOW_MS = exports.ABANDONED_TOOL_CALL_MS = exports.UNREAD_MAX_AGE_MS = exports.TOOL_STALL_MS = exports.PROMPT_WINDOW_MS = exports.STREAMING_WINDOW_MS = exports.SESSION_STATUSES = void 0;
exports.isQuestionTool = isQuestionTool;
exports.pendingStatusForTool = pendingStatusForTool;
exports.isApiError = isApiError;
exports.isCompaction = isCompaction;
exports.recordText = recordText;
exports.carriesToolResult = carriesToolResult;
exports.isInterruptMarker = isInterruptMarker;
exports.claudeStatusFromTail = claudeStatusFromTail;
exports.bobStatus = bobStatus;
exports.resolveDisplayStatus = resolveDisplayStatus;
exports.foldHookState = foldHookState;
exports.isBlockedOnYou = isBlockedOnYou;
exports.needsYou = needsYou;
exports.isWorklistSignal = isWorklistSignal;
/** Every state, in urgency order. Iterate this rather than re-listing the union. */
exports.SESSION_STATUSES = ['approval', 'question', 'finished', 'working', 'stalled', 'seen', 'dormant'];
// ── The four time windows every rule is built from ─────────────────────────────
//
// A transcript is an append-only log: the only liveness signal it carries is how long ago it was
// last written. Each window below is "quiet for longer than this means something different
// happened", and each is deliberately separate, because the three cases tolerate very different
// silences.
/** Assistant text still arriving. Token streaming writes far more often than this. */
exports.STREAMING_WINDOW_MS = 30000;
/**
 * A user prompt with no reply yet. Longer than the streaming window because the agent may be
 * thinking, queued behind another turn, or reconnecting — but bounded, so a transcript that ends
 * on a prompt nobody ever answered eventually goes quiet instead of pulsing for weeks.
 */
exports.PROMPT_WINDOW_MS = 120000;
/**
 * An unfinished tool call. A tool that is genuinely executing keeps the transcript moving; one
 * sitting on a permission prompt writes nothing at all. That difference is the only way to tell
 * "running" from "blocked on you" from the file alone — the live probe, when it can see the
 * session, is authoritative and does not need this.
 */
exports.TOOL_STALL_MS = 45000;
/**
 * How long an unopened result stays loud. A day-old finished session is history, not a task, and
 * marking it `finished` forever would leave History full of rows demanding attention.
 */
exports.UNREAD_MAX_AGE_MS = 24 * 3600000;
/**
 * When an unanswered tool call stops meaning "waiting for you" and starts meaning "abandoned".
 *
 * A transcript cannot tell those two apart on its own — both look like a tool call with nothing
 * written after it. `TOOL_STALL_MS` separates "running" from "blocked"; this separates "blocked"
 * from "the process that was blocked is gone".
 *
 * The bound has to exist. `approval` and `question` are the two states the worklist filter never
 * ages out (`isBlockedOnYou`) — deliberately, because a session waiting on you is stuck rather than
 * stale. Without an upper bound here, one session killed mid-tool-call is `approval` **forever**:
 * it sits at the top of the worklist for weeks, on the strength of a file that will never be
 * written again, and there is nothing you can do to clear it because there is no process left to
 * answer.
 *
 * A day, matching `UNREAD_MAX_AGE_MS`, for the same reason: after that long, silence is evidence
 * of abandonment rather than of patience. Nothing is lost by being wrong here — a session whose
 * window is genuinely still open stays in the worklist through the live probe, which does not
 * consult the status at all, and Bob's live pending approvals still upgrade it through
 * `resolveDisplayStatus`. What the bound removes is only the case where *no* live signal agrees
 * with the file, which is exactly the case where the file is the one lying.
 */
exports.ABANDONED_TOOL_CALL_MS = 24 * 3600000;
/**
 * How long after an API error a retry could still plausibly be in flight.
 *
 * Claude backs off and retries on its own, writing nothing in between, so this is "long enough that
 * a real retry is not reported as a stall". Generous compared with the streaming window — a rate
 * limit can hold for minutes — because the cost of being wrong is only that a stalled session reads
 * as `working` a while longer, and neither state asks anything of you.
 */
exports.API_RETRY_WINDOW_MS = 5 * 60000;
/** How long a compaction is given to finish before it is treated as a stall. */
exports.COMPACTION_WINDOW_MS = 5 * 60000;
// ── Question tools ────────────────────────────────────────────────────────────
/**
 * The tools that ask the user something rather than doing something.
 *
 * The distinction is not cosmetic: an approval takes a click, a question takes typing, and the
 * supervisor must never resolve a question through the approval emitter (that consumes the request
 * and the agent reports that you answered nothing). `SessionExporter` classifies pending actions
 * with the same predicate, so the two can never drift apart.
 */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ask_followup_question']);
function isQuestionTool(toolName) {
    return !!toolName && QUESTION_TOOLS.has(toolName);
}
/** Which blocked state a pending tool call means. */
function pendingStatusForTool(toolName) {
    return isQuestionTool(toolName) ? 'question' : 'approval';
}
/**
 * Is this record Claude Code reporting that a request to the API failed?
 *
 * These are written as `type: 'assistant'` with `model: '<synthetic>'`, `isApiErrorMessage: true`,
 * and text beginning `API Error:` — a rate limit, an overload, a DNS failure. Verified against real
 * transcripts, where the observed text was `API Error: Can't reach the API server …`.
 *
 * Naming them matters because of what they do to the walk. Claude retries after one of these, and
 * the retry writes nothing until it succeeds — so a rate-limited session is a transcript whose last
 * record is a tool call, or this, with a growing silence after it. `toolCallStatus` reads that
 * silence as `approval`, which is a false claim in the one state the worklist never ages out
 * (`isBlockedOnYou`): the row pins itself to the top of the list on the strength of a prompt that
 * does not exist and that you cannot clear, because there is nothing to answer.
 *
 * The three shapes are checked with `||` rather than `&&`. `isApiErrorMessage` alone is enough, and
 * the others are fallbacks for versions that may not set it — a missed API error costs a false
 * `approval`, so the detector errs toward recognising one.
 */
function isApiError(record) {
    if (record.isApiErrorMessage === true) {
        return true;
    }
    if (record.type !== 'assistant') {
        return false;
    }
    if (record.message?.model === '<synthetic>' && recordText(record).startsWith('API Error')) {
        return true;
    }
    return recordText(record).startsWith('API Error:');
}
/**
 * Is this the record Claude Code writes when it compacts a conversation?
 *
 * Compaction rewrites the context and then resumes, and it writes nothing while it runs — so a
 * transcript that ends here is *busy*, not blocked, and certainly not waiting on you. Left
 * unrecognised it falls through to the "nothing conclusive" case and goes `dormant` after 30
 * seconds, hiding a session that is about to start writing again.
 *
 * No compaction record appeared in the transcripts available when this was written, so the shape is
 * matched permissively across the three plausible markers rather than pinned to one. A false
 * positive here is cheap — it costs a `working` on a session that was going to be `dormant` — and
 * the check is last in the walk, so it only ever decides a record nothing else claimed.
 */
function isCompaction(record) {
    return record.isCompactSummary === true
        || record.compactMetadata !== undefined
        || record.type === 'compact-summary';
}
// Synthetic text Claude Code writes into a user-type record when you interrupt it. A marker,
// not a prompt: a session whose transcript ends on one is finished, not awaiting a reply.
const INTERRUPT_MARKERS = new Set([
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
]);
/** The plain text of a record's message, joining text blocks. */
function recordText(record) {
    const content = record.message?.content;
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('')
        .trim();
}
/**
 * Does this record carry a tool's result back to the agent?
 *
 * Claude Code writes tool results as **user-type** records — that is the shape, however odd it
 * reads — carrying `toolUseResult` and a `tool_result` block. Mistaking one for a typed prompt
 * pins a finished session in the worklist for weeks; skipping past one entirely is worse, because
 * the walk then reaches the tool call it answered and reports a completed call as still pending.
 */
function carriesToolResult(record) {
    if (record.type === 'tool_result') {
        return true;
    }
    if (record.toolUseResult !== undefined) {
        return true;
    }
    const content = record.message?.content;
    return Array.isArray(content) && content.some(b => b?.type === 'tool_result');
}
/** Synthetic text Claude Code writes as a user record when you interrupt it — a marker, not a prompt. */
function isInterruptMarker(record) {
    return INTERRUPT_MARKERS.has(recordText(record));
}
/** The names of the tool calls a record asks for, or `[]` if it asks for none. */
function toolNames(record) {
    const content = record.message?.content;
    const fromBlocks = Array.isArray(content)
        ? content.filter(b => b?.type === 'tool_use').map(b => b.name ?? '')
        : [];
    if (fromBlocks.length) {
        return fromBlocks;
    }
    return record.type === 'tool_use' ? [record.name ?? ''] : [];
}
/**
 * An unfinished tool call: running while the file still moves, blocked on you once it stops, and
 * abandoned once it has been silent for a day.
 *
 * The last step is checked first because it outranks the others: an abandoned call is not a
 * question you have failed to answer, whatever tool asked it.
 */
function toolCallStatus(names, quietMs) {
    if (quietMs >= exports.ABANDONED_TOOL_CALL_MS) {
        return 'dormant';
    }
    if (names.some(isQuestionTool)) {
        return 'question';
    }
    return quietMs >= exports.TOOL_STALL_MS ? 'approval' : 'working';
}
/**
 * Classify a Claude session from the tail of its transcript.
 *
 * `records` are the parsed records of the tail in file order; the walk runs backward from the end,
 * because the newest record that says anything about status is the one that decides. Records that
 * say nothing (`ai-title`, `file-history-snapshot`, injected context) are skipped rather than
 * treated as an answer — that skipping is most of what makes the result trustworthy.
 *
 * Walking backward also settles unfinished tool calls for free: the first tool-shaped record found
 * is either a result (so the call it belongs to came back) or a call (so nothing has answered it).
 */
function claudeStatusFromTail(records, updatedAtMs, nowMs) {
    const quietMs = Math.max(0, nowMs - updatedAtMs);
    for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i];
        // Checked before anything else, because an API error is written as an `assistant` record and
        // would otherwise be classified as ordinary assistant text — or, worse, be skipped so the walk
        // reaches the tool call it interrupted and reports that call as blocked on you. Claude retries
        // silently after one of these, so this is `working` while the retry could plausibly still be in
        // flight and `stalled` once it cannot: never `approval`, because nobody is being asked anything.
        if (isApiError(record)) {
            return quietMs < exports.API_RETRY_WINDOW_MS ? 'working' : 'stalled';
        }
        if (isCompaction(record)) {
            // Compaction writes nothing while it runs and then resumes on its own.
            return quietMs < exports.COMPACTION_WINDOW_MS ? 'working' : 'stalled';
        }
        if (carriesToolResult(record)) {
            // The last call came back and nothing was written after it. Either the agent is mid-turn, or
            // the turn was abandoned right there.
            return quietMs < exports.TOOL_STALL_MS ? 'working' : 'dormant';
        }
        if (record.type === 'user') {
            // Injected context — skill loads, scheduled prompts — is scenery, not a turn. Keep walking.
            if (record.isMeta === true) {
                continue;
            }
            // You stopped the agent yourself. The turn ended there; nothing is pending.
            if (isInterruptMarker(record)) {
                return 'finished';
            }
            // A real typed prompt: your turn is done, the agent's has not started yet.
            return quietMs < exports.PROMPT_WINDOW_MS ? 'working' : 'dormant';
        }
        if (record.type === 'tool_use') {
            return toolCallStatus(toolNames(record), quietMs);
        }
        // Terminal records, written when Claude Code closes a session out.
        if (record.type === 'pr-link' || record.type === 'last-prompt') {
            return 'finished';
        }
        if (record.type === 'assistant') {
            const names = toolNames(record);
            if (names.length) {
                return toolCallStatus(names, quietMs);
            }
            // Pure text: still streaming, or the answer you have not read yet.
            return quietMs < exports.STREAMING_WINDOW_MS ? 'working' : 'finished';
        }
    }
    // Nothing in the tail was conclusive. A file being written to right now is still activity;
    // anything else we simply cannot claim to know.
    return quietMs < exports.STREAMING_WINDOW_MS ? 'working' : 'dormant';
}
// ── Bob: classifying a task row ───────────────────────────────────────────────
/**
 * Classify a Bob task from its `tasks.status` column, plus a live pending approval when one is
 * known.
 *
 * Bob's own vocabulary is the trap here: its `'running'` means actively processing, but its
 * `'active'` means the task *finished* and is sitting in the sidebar. So the column alone can only
 * ever separate working from finished — the pending approval is what distinguishes "working" from
 * "waiting for you", and it lives in Bob's memory, not its database.
 */
function bobStatus(dbStatus, pending) {
    if (pending) {
        return pending;
    }
    return dbStatus === 'running' ? 'working' : 'finished';
}
/**
 * Turn the state derived from a file or a database row into the state actually shown.
 *
 * Three adjustments, and one deliberate non-adjustment:
 *
 *  - The **hook state**, when the session runs our hooks, replaces an inference with an observation:
 *    a prompt seen open becomes `approval`/`question` without waiting out `TOOL_STALL_MS`, and a
 *    session seen *ending* drops a blocked state immediately instead of after a day.
 *  - A live pending approval or question **upgrades** whatever we inferred. The live read comes
 *    from the agent's extension host, which knows for certain, so it outranks the hook trail.
 *  - A missing live signal never **downgrades** anything. The probe can only see the sessions in
 *    its own window, so "no pending approval reported" does not mean "no pending approval" — it
 *    routinely means the session is open in a different window. Treating silence as proof would
 *    turn every cross-window approval grey, which is the failure this design exists to fix. The same
 *    reasoning covers the hook trail: no records means the plugin is not installed there, not that
 *    the session is idle. Only an explicit `settled` may lower a state, because that is a positive
 *    observation of an ending rather than an absence of evidence.
 *  - `finished` splits on whether you have looked since, and stops shouting once it is a day old.
 */
function resolveDisplayStatus(base, input) {
    // A live host read outranks everything: it is looking at the running process.
    if (input.pending) {
        return input.pending;
    }
    const withHooks = foldHookState(base, input.hookState);
    if (withHooks !== 'finished') {
        return withHooks;
    }
    if (input.lastViewedMs !== undefined && input.lastViewedMs >= input.updatedAtMs) {
        return 'seen';
    }
    if (input.nowMs - input.updatedAtMs > exports.UNREAD_MAX_AGE_MS) {
        return 'dormant';
    }
    return 'finished';
}
/**
 * Apply what the hooks observed to what the transcript implied.
 *
 * Lives here, beside the state it returns, so `resolveDisplayStatus` can reach it without importing
 * `hookActivity.ts` — the dependency runs the other way. `applyHookState` there re-exports it.
 *
 * Ordered by how much each signal proves:
 *
 *  1. `pending` — a prompt was observed open. The strongest upgrade, and the point of the module:
 *     an observation at ~6s replacing an inference at 45s.
 *  2. `settled` — the session ended, so a blocked state is a zombie with no process left to answer
 *     it. The one downgrade, and only away from the live states: `finished` and `seen` are both still
 *     true of a session that ended, and are about reading rather than liveness.
 *  3. `idle` — the agent's turn ended and nobody typed. Only promotes `working`, never touches a
 *     blocked state.
 */
function foldHookState(base, state) {
    if (!state) {
        return base;
    }
    if (state.pending) {
        return state.pending;
    }
    if (state.settled) {
        return base === 'approval' || base === 'question' || base === 'working' || base === 'stalled'
            ? 'dormant'
            : base;
    }
    if (state.idle && base === 'working') {
        return 'finished';
    }
    return base;
}
// ── Predicates the rest of the extension asks about a state ───────────────────
//
// Written as exhaustive `Record<SessionStatus, boolean>` maps on purpose. An eighth state would
// then fail to compile here instead of silently falling through a comparison somewhere — and a
// status the worklist filter does not recognise is how sessions get quietly hidden in History.
const BLOCKED_ON_YOU = {
    // `stalled` is deliberately false: it is blocked on the API, not on you, and there is nothing you
    // could click. Marking it true would exempt it from the worklist's age bound and recreate the
    // zombie row this release exists to remove.
    approval: true, question: true, finished: false, working: false, stalled: false,
    seen: false, dormant: false,
};
const NEEDS_YOU = {
    // Nothing for you to do about a rate limit, so `stalled` does not ask for you.
    approval: true, question: true, finished: true, working: false, stalled: false,
    seen: false, dormant: false,
};
const WORKLIST_SIGNAL = {
    // A stalled session is live work that has gone wrong — it belongs in the worklist, on the same
    // recency terms as `working`, rather than being filed under History as though it had finished.
    approval: true, question: true, finished: false, working: true, stalled: true,
    seen: false, dormant: false,
};
/** Nothing moves until you act. These never age out of the worklist. */
function isBlockedOnYou(status) {
    return BLOCKED_ON_YOU[status] ?? false;
}
/** There is a reason to click this row: it is blocked on you, or it has a result you have not read. */
function needsYou(status) {
    return NEEDS_YOU[status] ?? false;
}
/** Does this state, on its own, argue the session belongs in the live worklist? */
function isWorklistSignal(status) {
    return WORKLIST_SIGNAL[status] ?? false;
}
