#!/usr/bin/env node
/**
 * The `SessionEnd` hook — close the session's audit record out.
 *
 * The registration file written at `SessionStart` says a session exists; without this, it says so
 * forever, and a worklist cannot tell a running session from one that ended two days ago. So the
 * same file is stamped with an end time, the reason, and the decision count — which is what makes
 * the overnight digest a bounded question ("this run", not "everything on disk").
 *
 * `SessionEnd` shares a **1.5 second** budget across all hooks, and a plugin's own `timeout` cannot
 * raise it. So this reads one small file, counts lines already on disk, and writes one file. It
 * never loads policy and never spawns anything.
 *
 * ## Stage A of the learning pipeline rides along here
 *
 * `accumulate()` folds everything in `decisions.jsonl` after the committed offset into
 * `pipeline/shapes.json`. It exercises no judgement — it folds counts — costs no tokens, and rewrites
 * one small file. `SessionEnd` is the only trigger that reliably fires on a laptop that sleeps, needs
 * no install step, no plist and no platform branch, and at that cost firing it too often is free.
 *
 * It is **offset-driven, not event-driven**, which is what makes it survive an unreliable trigger:
 * this hook does not analyse "the session that just ended", it folds every byte nobody has folded
 * yet. A `kill -9` that skips the hook entirely costs nothing, because the next session's close picks
 * up both. Two sessions closing at once means one fold and one silent no-op: the second finds the
 * lock held and returns, because the first is folding the same append-only file and will reach these
 * bytes too.
 *
 * The one thing it *says* is the nudge, when a shape has just crossed the support floor. Nothing is
 * proposed here. Proposing is `session-sitter learn`, attended, because a proposal a human sees
 * seconds after it is made is a proposal that gets corrected — and an unattended miner writing clause
 * files at 03:17 into a corpus nobody reads until Friday is how a policy corpus grows +226%.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DecisionRecord, appendJsonl, readJsonl } from '../audit/trail';
import { accumulate } from '../policy/pipeline';
import { activityPath, decisionsPath, sessionPath } from './paths';
import { HookInput, runHook } from './io';

/** Everything this hook may return. `systemMessage` is the nudge; absent when nothing crossed. */
export interface SessionEndOutput { systemMessage?: string }

export async function handle(input: HookInput): Promise<SessionEndOutput> {
  const sessionId = input.session_id ?? 'unknown';
  const file = sessionPath(sessionId);

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    // No registration — a session that started before the plugin was enabled, or a cleared data
    // dir. Close it out anyway rather than dropping the record.
  }

  const mine = readJsonl<DecisionRecord>(decisionsPath()).filter(r => r.sessionId === sessionId);
  const closed = {
    ...existing,
    sessionId,
    endedAt: new Date().toISOString(),
    endReason: typeof input.reason === 'string' ? input.reason : null,
    decisions: mine.length,
    denied: mine.filter(r => r.decision === 'deny').length,
    corrected: mine.filter(r => r.rewritten).length,
  };
  try {
    // The directory may not exist: a session that started before the plugin was enabled never had
    // a registration written, and closing it out is still worth doing.
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `${JSON.stringify(closed, null, 2)}\n`, 'utf8');
  } catch {
    // Nothing useful to do inside a 1.5 s budget with no way to report it. The decisions
    // themselves are already durable in the trail.
  }

  // The panel's terminal signal. The per-session file above is the audit record, but the panel reads
  // the activity trail — so one line goes there too, and it is what lets a blocked-looking transcript
  // be recognised as a *closed* session immediately rather than after `ABANDONED_TOOL_CALL_MS`.
  //
  // Written as a `waiting` record so it shares the shape `notification.ts` already uses: the panel's
  // reader (`src/hookActivity.ts`) folds one stream of wait records and needs no second parser.
  // One synchronous append, which is what the 1.5 s budget allows.
  appendJsonl(activityPath(), {
    ts: closed.endedAt,
    sessionId,
    waiting: 'session_end',
    message: typeof input.reason === 'string' ? input.reason.slice(0, 200) : null,
  });

  // Stage A. Wrapped because a fold must never be able to fail a session close: the trail is already
  // durable, so the worst case of a broken fold is that the next `SessionEnd` folds these bytes
  // instead — which is exactly the property being offset-driven buys.
  let nudge: string | null = null;
  try {
    nudge = accumulate('session-end').nudge;
  } catch {
    // The run line was already appended by `accumulate` itself, on failure as on success, so a
    // silent catch here still leaves a trace. That is the whole reason `pipeline.jsonl` exists.
  }
  return nudge === null ? {} : { systemMessage: nudge };
}

if (require.main === module) {
  void runHook(handle);
}
