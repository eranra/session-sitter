/**
 * The blocked state Claude Code told us about, rather than the one we inferred from a file's mtime.
 *
 * `sessionStatus.ts` reads a transcript from outside the process, so it can only ever deduce: a tool
 * call with nothing written after it, quiet for longer than `TOOL_STALL_MS`, is *probably* a
 * permission prompt. That inference is what the 45-second window buys, and it is the best a reader
 * of an append-only log can do.
 *
 * But we are not only a reader of that log. The plugin's hooks run *inside* the session
 * (`plugin/hooks/hooks.json`), and two of them already observe the blocked state directly and
 * write it down keyed by `session_id`:
 *
 *  - `permissionRequest.ts` appends a {@link DecisionRecord} to `decisions.jsonl` on every
 *    `PermissionRequest`. For `AskUserQuestion` and `ExitPlanMode` it takes the exempt path and
 *    records `decision: 'none'`, `actor: 'human'` — which is precisely "a human is being asked
 *    something, and this layer deliberately did not answer it".
 *  - `notification.ts` appends a {@link WaitRecord} to `activity.jsonl` for `permission_prompt`
 *    (~6s after the dialog appears) and `idle_prompt` (~60s after a turn ends with nobody typing).
 *
 * Both carry the session id, which is the join key `PendingWatcher` cannot get for Claude — Claude's
 * in-memory approvals are keyed by a comms channel instead, and the channel-to-session mapping is
 * not available to us. So this module is the Claude-shaped answer to the same question
 * `PendingWatcher` answers for Bob, and it feeds the identical `pending` slot on
 * `resolveDisplayStatus`.
 *
 * ## Why the trail can say "no longer blocked" and the inference cannot
 *
 * A prompt that has been *answered* leaves a mark. An approval that Claude Code went on to run
 * produces a `PostToolUse` record ({@link ActivityRecord}) carrying the same tool name; an answered
 * `AskUserQuestion` does too. So a pending prompt is one whose opening record has no closing record
 * after it — a bracket, not a timeout. That is what lets this module retract a stale `approval`
 * instead of waiting out `ABANDONED_TOOL_CALL_MS`.
 *
 * ## What this module refuses to do
 *
 * It never reports "this session is fine". Hooks only fire where the plugin is installed, so an
 * empty result means "no hook told us anything", never "nothing is blocked" — exactly the asymmetry
 * `resolveDisplayStatus` is built around. The one exception is narrow and explicit: see
 * {@link HookSessionState.settled}, which reports a *terminal* fact (the session ended, or the
 * prompt was answered) and is the only thing here allowed to argue a session is not blocked.
 *
 * Pure and clock-free, like `sessionStatus.ts`: records and `nowMs` arrive as arguments so every
 * branch is unit-testable.
 */

import type { SessionStatus } from './sessionStatus';
import { foldHookState, isQuestionTool, pendingStatusForTool } from './sessionStatus';

// ── The records this module reads ──────────────────────────────────────────────
//
// Declared structurally rather than imported from `src/audit/trail.ts` and `src/hooks/notification.ts`
// so the panel does not depend on the hook build, and so a record written by an older plugin version
// (JSONL has no schema) is read as data rather than crashing a repaint. Every field is optional for
// the same reason.

/** One line of `decisions.jsonl`: a governance decision, or an exempt tool's non-decision. */
export interface HookDecisionRecord {
  ts?: string;
  sessionId?: string;
  tool?: string;
  decision?: 'allow' | 'deny' | 'none';
  actor?: string;
}

/**
 * One line of `activity.jsonl`. The file holds two different record shapes — `postToolUse.ts`
 * writes a tool result, `notification.ts` writes a wait — told apart by which fields are present.
 */
export interface HookActivityRecord {
  ts?: string;
  sessionId?: string;
  /** Present on a tool-result record (`postToolUse`). */
  tool?: string;
  fingerprint?: string;
  ok?: boolean;
  /** Present on a wait record (`notification`): `permission_prompt` | `idle_prompt` | … */
  waiting?: string;
  message?: string | null;
}

/** A wait record's `waiting` value meaning a permission dialog is on screen. */
const PERMISSION_PROMPT = 'permission_prompt';

/** A wait record's `waiting` value meaning a turn ended and nobody has typed since. */
const IDLE_PROMPT = 'idle_prompt';

/**
 * Tools the `PermissionRequest` hook deliberately returns no verdict for, because both are questions
 * addressed to a human. Mirrors `EXEMPT_TOOLS` in `src/hooks/permissionRequest.ts`.
 *
 * `AskUserQuestion` maps to `question` through `isQuestionTool`. `ExitPlanMode` is a *plan* waiting
 * to be approved: it needs a yes/no rather than typing, so it reads as `approval`. Both are blocked
 * on you, which is the part that decides the row.
 */
const EXEMPT_QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * How long a hook-observed pending prompt is trusted without any further record.
 *
 * The bracket is the primary signal — a prompt is open until something closes it — but the closing
 * record can be lost: the session was killed mid-prompt, or the `PostToolUse` hook failed to write.
 * Without a bound, one lost record pins a row to the top of the worklist forever, which is the exact
 * zombie `ABANDONED_TOOL_CALL_MS` exists to prevent in the inferred path.
 *
 * A day, matching `ABANDONED_TOOL_CALL_MS`, for the same reason and so the two paths age out
 * together — a session must not be `approval` by one route and `dormant` by the other.
 */
export const HOOK_PENDING_MAX_AGE_MS = 24 * 3600_000;

/**
 * How long an `idle_prompt` is treated as evidence the agent is waiting on you.
 *
 * `idle_prompt` fires ~60s after a turn ends with nothing typed, so it is a real observation that
 * the agent finished and is waiting. It ages out because "you did not reply within a minute" stops
 * being interesting long before the day a blocked prompt is given: this only refines `finished` vs
 * `working`, and `resolveDisplayStatus` already splits `finished` by whether you have read it.
 */
export const HOOK_IDLE_MAX_AGE_MS = 2 * 3600_000;

// ── What the hook trail concluded about one session ────────────────────────────

/**
 * The live facts the hook trail carries about a single session.
 *
 * Every field is deliberately an *upgrade* except `settled`, which is the one terminal signal — see
 * the module docstring.
 */
export interface HookSessionState {
  /** A prompt is open and nothing has answered it. Feeds `resolveDisplayStatus`'s `pending`. */
  pending?: 'approval' | 'question';
  /**
   * The tool whose prompt is open, or the last tool that actually *ran*. Shown as the row's subtitle.
   *
   * Set from `PostToolUse` records rather than from decisions, because a decision only says a call
   * was permitted — the run may have been denied, or the session may have ended before it started.
   */
  tool?: string;
  /** The agent finished its turn and is waiting for you to type. Argues `finished` over `working`. */
  idle?: boolean;
  /**
   * A terminal fact: the session ended, so nothing is pending regardless of what the transcript's
   * last record looks like. The only field here permitted to *lower* a status, and it is safe to
   * because it is a positive observation of an ending rather than an absence of evidence.
   */
  settled?: boolean;
  /** When the newest record backing the above was written. */
  atMs?: number;
}

/**
 * Fold one session's hook records into its live state.
 *
 * Records for the session in file order, oldest first — `readJsonl` already returns them that way,
 * including the rotated generation. The walk is forward rather than backward (the opposite of
 * `claudeStatusFromTail`) because a *bracket* is being matched, not a tail classified: an opening
 * record is only pending if no closing record comes after it, which is a question about order.
 */
export function hookStateForSession(
  records: readonly HookTrailRecord[], nowMs: number,
): HookSessionState {
  const state: HookSessionState = {};
  // The prompt currently believed open, if any. Overwritten by a newer opening record and cleared
  // by anything that closes one.
  let open: { kind: 'approval' | 'question'; tool: string; atMs: number } | undefined;
  let idleAtMs: number | undefined;
  let lastTool: string | undefined;
  let endedAtMs: number | undefined;

  for (const record of records) {
    const atMs = parseTs(record.ts);

    if (isSessionEnd(record)) {
      // A session that ended cannot be waiting on you. This is the terminal signal.
      endedAtMs = atMs ?? nowMs;
      open = undefined;
      idleAtMs = undefined;
      continue;
    }

    // A tool *ran*. Whatever prompt guarded it has been answered, so the bracket closes.
    if (isToolResult(record)) {
      lastTool = typeof record.tool === 'string' && record.tool ? record.tool : lastTool;
      if (closes(open, record.tool)) { open = undefined; }
      // Anything running at all means the agent is not sitting idle waiting for you, and it also
      // means the session is alive again — a resumed session reuses its id, so records accumulate
      // across runs and an older `session_end` must not bury a newer run's activity.
      idleAtMs = undefined;
      endedAtMs = undefined;
      continue;
    }

    const opened = openedPrompt(record);
    if (opened) {
      open = { kind: opened.kind, tool: opened.tool, atMs: atMs ?? nowMs };
      // A prompt on screen is the opposite of idle, and proof the session is running.
      idleAtMs = undefined;
      endedAtMs = undefined;
      continue;
    }

    // A decision the hook actually answered — allowed or denied — means no human was asked. It also
    // closes a prompt that this same call had opened.
    if (isAnsweredDecision(record)) {
      if (closes(open, record.tool)) { open = undefined; }
      endedAtMs = undefined;
      continue;
    }

    if (isIdlePrompt(record)) {
      // An idle notification only counts while no prompt is open: a `permission_prompt` and an
      // `idle_prompt` can both be recent, and the blocked state is the more urgent truth.
      if (!open) { idleAtMs = atMs ?? nowMs; }
      continue;
    }
  }

  if (endedAtMs !== undefined) {
    state.settled = true;
    state.atMs = endedAtMs;
    if (lastTool) { state.tool = lastTool; }
    return state;
  }

  if (open && nowMs - open.atMs < HOOK_PENDING_MAX_AGE_MS) {
    state.pending = open.kind;
    if (open.tool) { state.tool = open.tool; }
    state.atMs = open.atMs;
    return state;
  }

  if (idleAtMs !== undefined && nowMs - idleAtMs < HOOK_IDLE_MAX_AGE_MS) {
    state.idle = true;
    state.atMs = idleAtMs;
  }
  if (lastTool) { state.tool = lastTool; }
  return state;
}

/** Either record shape the two hook trail files hold. */
export type HookTrailRecord = HookDecisionRecord & HookActivityRecord;

/**
 * Group every trail record by session, then fold each group.
 *
 * `decisions` and `activity` are separate files written by different hooks, and the bracket spans
 * both — a prompt opens in `decisions.jsonl` and closes in `activity.jsonl`. So they are merged and
 * sorted by timestamp before folding; interleaving them by file would break the ordering the walk
 * depends on.
 */
export function hookStatesBySession(
  decisions: readonly HookDecisionRecord[],
  activity: readonly HookActivityRecord[],
  nowMs: number,
): Map<string, HookSessionState> {
  const bySession = new Map<string, HookTrailRecord[]>();
  for (const record of [...decisions, ...activity] as HookTrailRecord[]) {
    const id = record.sessionId;
    if (!id || id === 'unknown') { continue; }
    const list = bySession.get(id);
    if (list) { list.push(record); } else { bySession.set(id, [record]); }
  }

  const out = new Map<string, HookSessionState>();
  for (const [id, records] of bySession) {
    records.sort((a, b) => (parseTs(a.ts) ?? 0) - (parseTs(b.ts) ?? 0));
    const state = hookStateForSession(records, nowMs);
    // An empty conclusion is not worth carrying: it says nothing the caller does not already assume.
    if (state.pending || state.idle || state.settled || state.tool) { out.set(id, state); }
  }
  return out;
}

// ── Record predicates ─────────────────────────────────────────────────────────

/**
 * Does a completed tool call close the prompt currently believed open?
 *
 * The two cases are genuinely different, and collapsing them was a bug worth naming:
 *
 *  - An **unnamed** prompt — one that came from a `permission_prompt` notification, which carries no
 *    tool name — is closed by the next completed call whatever it was. There is nothing to match on,
 *    and over-holding is the worse failure: an `approval` nothing can clear pins itself to the top of
 *    the worklist, and unlike an inferred one it has no timer to fall out of.
 *  - A **named** prompt is closed only by its own tool. Claude runs several tools per turn, so an
 *    auto-approved `Read` finishing while an `ExitPlanMode` prompt sits on screen proves nothing
 *    about that prompt.
 */
function closes(
  open: { tool: string } | undefined, completedTool: string | undefined,
): boolean {
  if (!open) { return false; }
  if (!open.tool) { return true; }
  return completedTool === open.tool;
}

function parseTs(ts: string | undefined): number | undefined {
  if (!ts) { return undefined; }
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A `PostToolUse` record: a tool produced a result. Identified by its fingerprint field. */
function isToolResult(record: HookTrailRecord): boolean {
  return typeof record.fingerprint === 'string' && record.fingerprint.length > 0;
}

/** A wait record saying a permission dialog is on screen. */
function isPermissionPrompt(record: HookTrailRecord): boolean {
  return record.waiting === PERMISSION_PROMPT;
}

/** A wait record saying the agent finished and nobody has typed. */
function isIdlePrompt(record: HookTrailRecord): boolean {
  return record.waiting === IDLE_PROMPT;
}

/** The `SessionEnd` hook's record. */
function isSessionEnd(record: HookTrailRecord): boolean {
  return record.waiting === 'session_end';
}

/**
 * Did this record open a prompt a human now has to answer?
 *
 * Two shapes qualify, and they are different observations of the same thing:
 *
 *  - an **exempt** decision (`decision: 'none'`, `actor: 'human'`) for `AskUserQuestion` or
 *    `ExitPlanMode` — the hook was asked and deliberately declined to answer, leaving the question
 *    with the person it was addressed to. This is the *earliest* signal available for a question:
 *    it lands when the tool is called, before any notification fires.
 *  - a `permission_prompt` wait record — the dialog is on screen. This is the signal for an ordinary
 *    approval, which the hook cannot report as exempt because it genuinely tried to decide it.
 */
function openedPrompt(
  record: HookTrailRecord,
): { kind: 'approval' | 'question'; tool: string } | undefined {
  const tool = typeof record.tool === 'string' ? record.tool : '';

  if (record.decision === 'none' && EXEMPT_QUESTION_TOOLS.has(tool)) {
    return { kind: pendingStatusForTool(tool), tool };
  }

  if (isPermissionPrompt(record)) {
    // A notification carries no tool name — the message text is all there is — so the tool is left
    // empty and the bracket is closed by the next tool result whatever it is. Deliberate: an
    // approval whose tool we cannot name still has to clear, and over-holding it is the worse error.
    return { kind: isQuestionTool(tool) ? 'question' : 'approval', tool };
  }

  return undefined;
}

/** A decision the hook itself resolved: nothing was asked of a human. */
function isAnsweredDecision(record: HookTrailRecord): boolean {
  return record.decision === 'allow' || record.decision === 'deny';
}

// ── Folding hook state into a status ──────────────────────────────────────────

/**
 * Apply one session's hook state to the status inferred from its transcript.
 *
 * The rules live in `foldHookState` in `sessionStatus.ts`, beside the state they return and reachable
 * from `resolveDisplayStatus` without a circular import. Re-exported under this name because this is
 * the module a reader looking for hook behaviour will open first.
 */
export function applyHookState(
  base: SessionStatus, state: HookSessionState | undefined,
): SessionStatus {
  return foldHookState(base, state);
}
