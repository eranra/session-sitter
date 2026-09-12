/**
 * Keeps the panel's view of the hook trail fresh, so a Claude row can show *why* it is stuck without
 * waiting out `TOOL_STALL_MS`.
 *
 * The sibling of `PendingWatcher`, for the other agent and the other signal. `PendingWatcher` polls
 * Bob's in-memory approvals through the extension host, which is certain but Bob-only — Claude's
 * pendings are keyed by a comms channel we cannot map to a session. This watcher polls the files the
 * plugin's own hooks write, which *are* keyed by session id, and so closes that gap for Claude. Both
 * feed the same `pending` slot on `resolveDisplayStatus`; see `src/hookActivity.ts` for the rules.
 *
 * Deliberately a poller rather than a file watcher. The trail is append-only JSONL written by short
 * hook processes several times per tool call, so a watcher would fire far more often than the panel
 * repaints and would still need a debounce; and `fs.watch` is the least portable thing in Node — it
 * misses events on network mounts and in WSL2, both of which this extension runs in. A 4-second poll
 * of two files is cheaper than getting that right, and its worst case is bounded and obvious.
 */

import { readJsonl } from './audit/trail';
import { activityPath, decisionsPath } from './hooks/paths';
import {
  HookActivityRecord, HookDecisionRecord, HookSessionState, hookStatesBySession,
} from './hookActivity';

/**
 * How often the trail is re-read.
 *
 * Faster than `PendingWatcher`'s 5s because this is the signal that makes an approval visible at all
 * for Claude, and the hook that produces it (`permission_prompt`) already costs ~6 seconds of
 * latency. Reading two append-only files is far cheaper than the inspector call `PendingWatcher`
 * makes, so the shorter interval is affordable.
 */
const DEFAULT_POLL_MS = 4_000;

/** What the watcher exposes to the panel: session id → what the hooks observed. */
export type HookStates = ReadonlyMap<string, HookSessionState>;

export class HookActivityWatcher {
  private _states: HookStates = new Map();
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _polling = false;
  /** The signature of the last poll's conclusion, so an unchanged trail causes no repaint. */
  private _signature = '';

  private onChange: () => void = () => { /* no-op */ };

  constructor(
    private readonly log: (msg: string) => void = () => { /* no-op */ },
    private readonly pollMs = DEFAULT_POLL_MS,
    /** Injected in tests. Defaults to the real trail files. */
    private readonly read: () => {
      decisions: HookDecisionRecord[]; activity: HookActivityRecord[];
    } = defaultRead,
    private readonly now: () => number = Date.now,
  ) { }

  /**
   * What to call when the trail's conclusion changes, so the panel repaints on the tick a prompt
   * appears rather than on the next session scan. A setter for the same reason as `PendingWatcher`'s:
   * the watcher has to exist before the view provider that reads its snapshot.
   */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** The current map. Read on every repaint, so it must be cheap and must never throw. */
  snapshot(): HookStates {
    return this._states;
  }

  start(): void {
    if (this._timer) { return; }
    this.poll();
    this._timer = setInterval(() => { this.poll(); }, this.pollMs);
  }

  /**
   * Re-read the trail and rebuild the map.
   *
   * A failed read leaves the previous map in place rather than clearing it, exactly as
   * `PendingWatcher` does: clearing would turn one unreadable file into "nothing is blocked", which
   * is the false negative this whole design refuses to draw.
   */
  poll(): void {
    if (this._polling) { return; }
    this._polling = true;
    try {
      let decisions: HookDecisionRecord[];
      let activity: HookActivityRecord[];
      try {
        ({ decisions, activity } = this.read());
      } catch (err) {
        this.log(`hook activity: trail read failed: ${String(err)}`);
        return;
      }

      const next = hookStatesBySession(decisions, activity, this.now());

      // Only the blocked states are worth logging or repainting for. `tool` changes on every tool
      // call, and a repaint per tool call across every open session is the cost this signature avoids.
      const signature = [...next]
        .filter(([, s]) => s.pending || s.settled || s.idle)
        .map(([id, s]) => `${id}:${s.pending ?? ''}${s.settled ? 'E' : ''}${s.idle ? 'I' : ''}`)
        .sort()
        .join(',');

      this._states = next;
      if (signature !== this._signature) {
        this._signature = signature;
        const blocked = [...next].filter(([, s]) => s.pending);
        this.log(blocked.length === 0
          ? 'hook activity: no session is blocked'
          : `hook activity: ${blocked.length} blocked — `
            + blocked.map(([id, s]) => `${id}=${s.pending}`).join(', '));
        this.onChange();
      }
    } finally {
      this._polling = false;
    }
  }

  dispose(): void {
    if (this._timer) { clearInterval(this._timer); }
    this._timer = undefined;
  }
}

/**
 * Read both trail files.
 *
 * `readJsonl` already skips malformed lines and includes the one rotated generation, and returns
 * `[]` for a file that does not exist — which is the normal case on a machine where the plugin has
 * never run.
 */
function defaultRead(): { decisions: HookDecisionRecord[]; activity: HookActivityRecord[] } {
  return {
    decisions: readJsonl<HookDecisionRecord>(decisionsPath()),
    activity: readJsonl<HookActivityRecord>(activityPath()),
  };
}
