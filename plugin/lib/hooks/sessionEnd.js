#!/usr/bin/env node
// GENERATED FILE — DO NOT EDIT.
// Compiled from src/hooks/sessionEnd.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
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
exports.handle = handle;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const trail_1 = require("../audit/trail");
const pipeline_1 = require("../policy/pipeline");
const paths_1 = require("./paths");
const io_1 = require("./io");
async function handle(input) {
    const sessionId = input.session_id ?? 'unknown';
    const file = (0, paths_1.sessionPath)(sessionId);
    let existing = {};
    try {
        existing = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    }
    catch {
        // No registration — a session that started before the plugin was enabled, or a cleared data
        // dir. Close it out anyway rather than dropping the record.
    }
    const mine = (0, trail_1.readJsonl)((0, paths_1.decisionsPath)()).filter(r => r.sessionId === sessionId);
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
    }
    catch {
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
    (0, trail_1.appendJsonl)((0, paths_1.activityPath)(), {
        ts: closed.endedAt,
        sessionId,
        waiting: 'session_end',
        message: typeof input.reason === 'string' ? input.reason.slice(0, 200) : null,
    });
    // Stage A. Wrapped because a fold must never be able to fail a session close: the trail is already
    // durable, so the worst case of a broken fold is that the next `SessionEnd` folds these bytes
    // instead — which is exactly the property being offset-driven buys.
    let nudge = null;
    try {
        nudge = (0, pipeline_1.accumulate)('session-end').nudge;
    }
    catch {
        // The run line was already appended by `accumulate` itself, on failure as on success, so a
        // silent catch here still leaves a trace. That is the whole reason `pipeline.jsonl` exists.
    }
    return nudge === null ? {} : { systemMessage: nudge };
}
if (require.main === module) {
    void (0, io_1.runHook)(handle);
}
