import * as vscode from 'vscode';
import * as inspector from 'inspector';
import { runExclusive } from './BobInspector';

export interface ClaudeOpenState {
  open: string[];        // union of `panels` and `states` — every session this window holds
  panels: string[];      // sessions open as EDITOR PANELS (sessionPanels keys)
  states: string[];      // every session the manager holds (sessionStates keys)
  active: string | null; // the focused session id (activeSessionId) — panels only
  sidebar: boolean;      // is Claude's side bar view RESOLVED in this window (sidebarComms)?
  diag?: string;         // how the probe resolved (for debugging reachability)
}

// Injected with `this` = Claude's manager instance (module-global `gB`, class Xq).
// Reports the two maps SEPARATELY, because they mean different things and the
// difference is what tells us WHERE a session lives:
//   - sessionPanels: Map<sessionId, WebviewPanel> — sessions open as editor panels.
//     Authoritative and self-pruning (the entry is deleted when the panel is
//     disposed). Claude broadcasts exactly these keys to its own UI as
//     `openSessionIds`, and labels them "Switch to session" rather than "Resume
//     session" — so this IS Claude's own definition of "open in the editor".
//   - sessionStates: Map<sessionId, {info, author}> — every session the manager
//     holds, including one shown in the sidebar view. This ACCUMULATES: entries
//     are only removed when their authoring surface is disposed (`lT0`) or a
//     restore is declined (`cT0`), never when the sidebar switches session, and
//     growth is bounded only by a size cap (`gT0`). So it means "this window's
//     manager knows this session" — NOT "this session is visible right now".
//   - sidebarComms: the comms object of the side bar webview view. Claude sets it
//     in `resolveWebviewView` and clears it on dispose, so `!!sidebarComms` is the
//     window's live answer to "does Claude's side bar view exist right now" — for
//     EITHER container, since Claude registers one provider for both
//     `claudeVSCodeSidebar` and `claudeVSCodeSidebarSecondary`. We read this rather
//     than the `claudeCode.preferredLocation` setting because that setting records
//     how Claude was last *asked* to open, not where its view actually is: only
//     `claude-vscode.sidebar.open` writes 'sidebar', so revealing the secondary side
//     bar from VS Code's own UI leaves it reading 'panel' while the view is on screen.
// Merging panels and states (what we used to do) throws the location away, which is
// why we could not tell a sidebar session from a closed one.
const READ_OPEN_FN = `function(){
  try {
    var panels = [], states = [];
    if (this.sessionPanels && typeof this.sessionPanels.keys === 'function') {
      for (var a of this.sessionPanels.keys()) panels.push(a);
    }
    if (this.sessionStates && typeof this.sessionStates.keys === 'function') {
      for (var b of this.sessionStates.keys()) states.push(b);
    }
    return JSON.stringify({
      panels: panels, states: states, active: this.activeSessionId || null,
      sidebar: !!this.sidebarComms,
    });
  } catch (e) { return JSON.stringify({ panels: [], states: [], active: null, err: String(e) }); }
}`;

// Probe a closure variable: is it Claude's manager? (has the sessionPanels Map and createPanel)
const MANAGER_PROBE =
  `function(){ return !!(this && this.sessionPanels instanceof Map && typeof this.createPanel === 'function'); }`;

// Global slot used to hand Claude's `activate` function to the inspector eval
// context (the eval context has no `require`, but our CommonJS module does).
const GLOBAL_SLOT = '__sessionSitter_claudeActivate';

/**
 * Find Claude Code's exported `activate` function (minified `wdt`) from the
 * process-global CommonJS module cache. `activate` closes over the module-local
 * `gB` (the manager instance), so walking its [[Scopes]] reaches the live manager.
 * Claude's activate returns no API, so — unlike Bob — `getExtension().exports` is
 * empty; the module cache is how we get a function object from Claude's module.
 * Returns the function, or a `DIAG:*` string describing why it wasn't found.
 */
function findClaudeActivate(): ((...args: unknown[]) => unknown) | string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (require as any)?.cache as Record<string, { exports?: { activate?: unknown } }> | undefined;
  if (!cache) { return 'DIAG:no-require.cache'; }
  const keys = Object.keys(cache);
  const matches = keys.filter(k => k.toLowerCase().includes('anthropic.claude-code') && /extension\.js$/.test(k));
  if (!matches.length) { return `DIAG:no-claude-module (cacheTotal=${keys.length})`; }
  for (const k of matches) {
    const a = cache[k]?.exports?.activate;
    if (typeof a === 'function') { return a as (...args: unknown[]) => unknown; }
  }
  return `DIAG:activate-not-fn (claudeModules=${matches.length})`;
}

const EMPTY_OPEN_STATE: ClaudeOpenState = { open: [], panels: [], states: [], active: null, sidebar: false };

/** Dedupe and drop non-string / empty entries from a raw id array. */
function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  return [...new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/**
 * Ids in `states` that no open panel accounts for.
 *
 * `open` is the union of the two, so every one of these counts as a session this window holds — and
 * therefore as *active*, at any age, with no way to age out. That is right if Claude drops a
 * session's state when its panel closes, and wrong if it keeps it: then every session ever opened in
 * a window stays active until the window is reloaded.
 *
 * Which of those Claude actually does is not documented and was not reproducible on the machine
 * where the over-long session list was reported, so the union is left exactly as it was. This
 * function exists to make the question answerable from a log instead of by guesswork: when the list
 * holds sessions you do not recognise, these are the ids to suspect.
 */
export function statesWithoutPanel(state: ClaudeOpenState): string[] {
  const panels = new Set(state.panels);
  return state.states.filter(id => !panels.has(id));
}

/** Parse the JSON payload READ_OPEN_FN returns into a ClaudeOpenState.
 *  `open` is derived as the union of `panels` and `states`, so existing callers
 *  that only care whether a session is held by this window keep working.
 *  Returns an empty state for any malformed input. Pure — unit-tested. */
export function parseClaudeOpenState(raw: unknown): ClaudeOpenState {
  if (typeof raw !== 'string') { return { ...EMPTY_OPEN_STATE }; }
  try {
    const p = JSON.parse(raw) as {
      panels?: unknown; states?: unknown; active?: unknown; sidebar?: unknown;
    };
    const panels = cleanIds(p.panels);
    const states = cleanIds(p.states);
    const active = typeof p.active === 'string' && p.active.length > 0 ? p.active : null;
    return {
      open: [...new Set([...panels, ...states])], panels, states, active,
      sidebar: p.sidebar === true,
    };
  } catch {
    return { ...EMPTY_OPEN_STATE };
  }
}

// Dumps the manager's own shape so we can discover which field holds open
// sessions. Reports own property names, and for Map/Set/string/null fields their
// size/keys/value — enough to locate where the open session id lives.
const DUMP_FN = `function(){
  try {
    var out = { props: [], detail: {}, active: this.activeSessionId || null };
    var names = Object.getOwnPropertyNames(this);
    out.props = names;
    for (var i=0;i<names.length;i++){
      var k=names[i], v;
      try { v=this[k]; } catch(e){ continue; }
      if (v instanceof Map) out.detail[k]={t:'Map',size:v.size,keys:Array.from(v.keys()).slice(0,20)};
      else if (v instanceof Set) out.detail[k]={t:'Set',size:v.size};
      else if (typeof v==='string') out.detail[k]={t:'string',v:v.slice(0,80)};
      else if (v===null||v===undefined) out.detail[k]={t:String(v)};
      else if (typeof v==='object') out.detail[k]={t:'object',ctor:(v.constructor&&v.constructor.name)||'?'};
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

// Read-only v5 capture: for the comm in allComms, report per channel — the
// channel map key (channelId); the scalar own-props of the channel and of
// query.initConfig (to spot the sessionId↔channel correlation); a bounded
// stringify of the first queued input item (channel.in.queue /
// query.inputStream.queue / query.transport.pendingWrites — the real send
// envelope); and any pending/permission/control array or map on query (the
// approval metadata source). Plus the ids in comm.outstandingRequests. Mutates
// nothing. Resolves the three unknowns blocking ClaudeSender/ClaudeApprover:
// send envelope, session↔channel correlation, approval metadata source.
const SEND_APPROVAL_PROBE_FN = `function(){
  try {
    var cut = function(x){ try { var s = JSON.stringify(x); return s ? s.slice(0,800) : ('' + x); } catch(e){ return 'unstringifiable:' + (typeof x); } };
    var firstOf = function(arr){ return (arr && arr.length) ? arr[0] : undefined; };
    var comm;
    if (this.allComms && this.allComms.forEach) this.allComms.forEach(function(c){ if (comm===undefined) comm=c; });
    if (!comm) return JSON.stringify({ err: 'no comm' });
    var out = { channels: [], outstandingRequestIds: [] };
    if (comm.outstandingRequests && comm.outstandingRequests.forEach) {
      comm.outstandingRequests.forEach(function(_v,k){ out.outstandingRequestIds.push(k); });
    }
    if (comm.channels && comm.channels.forEach) {
      comm.channels.forEach(function(ch, id){
        var e = { channelId: id, scalarProps: {}, initConfig: {}, inputSample: null, permissionish: {} };
        try {
          var names = Object.getOwnPropertyNames(ch);
          for (var i=0;i<names.length;i++){ var v; try{v=ch[names[i]];}catch(x){continue;} if (v===null||['string','number','boolean'].indexOf(typeof v)>=0) e.scalarProps[names[i]] = v; }
        } catch(x){}
        try {
          var ic = ch.query && ch.query.initConfig;
          if (ic) { var ik = Object.getOwnPropertyNames(ic); for (var j=0;j<ik.length;j++){ var iv; try{iv=ic[ik[j]];}catch(x){continue;} if (iv===null||['string','number','boolean'].indexOf(typeof iv)>=0) e.initConfig[ik[j]] = iv; } }
        } catch(x){}
        try {
          var q = ch.query || {};
          var cand = [ ch['in'] && ch['in'].queue, q.inputStream && q.inputStream.queue, q.transport && q.transport.pendingWrites ];
          for (var c=0;c<cand.length;c++){ var f = firstOf(cand[c]); if (f !== undefined) { e.inputSample = cut(f); break; } }
          var qn = Object.getOwnPropertyNames(q);
          for (var p=0;p<qn.length;p++){ if (/pending|permission|request|unmatched|control/i.test(qn[p])) { var qv; try{qv=q[qn[p]];}catch(x){continue;} if (qv instanceof Map) e.permissionish[qn[p]] = 'Map('+qv.size+')'; else if (Array.isArray(qv)) e.permissionish[qn[p]] = cut(qv); } }
        } catch(x){}
        out.channels.push(e);
      });
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: String(e) }); }
}`;

/**
 * Reach Claude Code's live manager instance (`gB`) via the V8 inspector and run
 * `functionDeclaration` on it (with `this` = the manager). Returns the call's
 * string result plus a diag describing how the reach resolved. Never throws.
 *
 * Claude's `activate` returns no API, so — unlike Bob — `getExtension().exports`
 * is empty. We instead take Claude's `activate` (which closes over `gB`) from our
 * own CommonJS `require.cache`, stash it on `globalThis`, and walk its [[Scopes]].
 */
export function callOnClaudeManager(
  functionDeclaration: string,
  log: (msg: string) => void,
): Promise<{ raw: string | undefined; diag: string }> {
  // Serialize with all other inspector access (Bob + Claude) — one shared V8
  // inspector surface; overlapping sessions/globals cause intermittent no-ops.
  return runExclusive(() => callOnClaudeManagerUnsafe(functionDeclaration, log));
}

async function callOnClaudeManagerUnsafe(
  functionDeclaration: string,
  log: (msg: string) => void,
): Promise<{ raw: string | undefined; diag: string }> {
  const claudeIds = vscode.extensions.all.map(e => e.id).filter(id => id.toLowerCase().includes('claude'));
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (!ext) {
    const diag = `ext-not-found (claude exts: ${claudeIds.join(', ') || 'none'})`;
    log('claude inspector: ' + diag);
    return { raw: undefined, diag };
  }
  const activeNote = ext.isActive ? 'active' : 'INACTIVE';

  const activateFn = findClaudeActivate();
  if (typeof activateFn === 'string') {
    const diag = `reach-fail (${activeNote}): ${activateFn}`;
    log('claude inspector: ' + diag);
    return { raw: undefined, diag };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any)[GLOBAL_SLOT] = activateFn;

  const session = new inspector.Session();
  session.connect();
  // Bound each round-trip so a stuck call surfaces as an error, not a hang.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const post = (method: string, params?: any): Promise<any> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout ' + method)), 3000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.post(method as any, params, (e: any, r: any) => { clearTimeout(timer); e ? rej(e) : res(r); });
    });

  try {
    await post('Runtime.enable');
    const fn = await post('Runtime.evaluate', { expression: `globalThis.${GLOBAL_SLOT}`, returnByValue: false });
    if (fn.result?.type !== 'function' || !fn.result?.objectId) {
      const diag = `eval-no-fn (${activeNote}): ${fn.result?.value ?? fn.result?.type}`;
      log('claude inspector: ' + diag);
      return { raw: undefined, diag };
    }
    const fnProps = await post('Runtime.getProperties', { objectId: fn.result.objectId, ownProperties: false, generatePreview: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopesEntry = (fnProps.internalProperties || []).find((p: any) => p.name === '[[Scopes]]');
    if (!scopesEntry?.value?.objectId) { return { raw: undefined, diag: 'no-scopes' }; }

    const scopes = await post('Runtime.getProperties', { objectId: scopesEntry.value.objectId, ownProperties: false });
    let scopeCount = 0, varCount = 0;
    for (const scope of scopes.result || []) {
      if (!scope.value?.objectId) { continue; }
      scopeCount++;
      const vars = await post('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      for (const v of vars.result || []) {
        if (!v.value?.objectId) { continue; }
        varCount++;
        const probe = await post('Runtime.callFunctionOn', {
          objectId: v.value.objectId, functionDeclaration: MANAGER_PROBE, returnByValue: true,
        });
        if (probe.result?.value === true) {
          const res = await post('Runtime.callFunctionOn', {
            objectId: v.value.objectId, functionDeclaration, returnByValue: true,
          });
          return { raw: res.result?.value, diag: 'ok' };
        }
      }
    }
    const diag = `gB-not-found (scopes=${scopeCount}, vars=${varCount})`;
    log('claude inspector: ' + diag);
    return { raw: undefined, diag };
  } catch (err) {
    const diag = 'error ' + String(err);
    log('claude inspector: ' + diag);
    return { raw: undefined, diag };
  } finally {
    session.disconnect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any)[GLOBAL_SLOT];
  }
}

/**
 * Ask Claude Code's live extension which session panels are open in this window
 * (its own truth, not a heuristic). Returns an empty state on any failure.
 */
export async function getOpenClaudeSessionIds(log: (msg: string) => void): Promise<ClaudeOpenState> {
  const { raw, diag } = await callOnClaudeManager(READ_OPEN_FN, log);
  const state = parseClaudeOpenState(raw);
  state.diag = diag === 'ok'
    ? `ok (panels=${state.panels.length}, states=${state.states.length}, sidebar=${state.sidebar})`
    : diag;
  if (diag === 'ok') {
    log(
      `claude inspector: panels=[${state.panels.join(', ')}] states=[${state.states.join(', ')}] `
      + `active=${state.active} sidebar=${state.sidebar}`);
    // Called out separately, because it is buried in the line above and it is the difference between
    // "this window holds two sessions" and "this window has held twenty since it started".
    const orphans = statesWithoutPanel(state);
    if (orphans.length > 0) {
      log(
        `claude inspector: ${orphans.length} session(s) have state but no open panel, and still `
        + `count as open here: ${orphans.join(', ')}`);
    }
  }
  return state;
}

/**
 * How a side bar reveal resolved. `revealed` means the side bar is now showing this
 * session; `activated` means Claude accepted the session switch but we could not find
 * its view object to bring forward, so the caller should focus the view by id.
 */
export type SidebarRevealOutcome = 'revealed' | 'activated' | 'unavailable';

/**
 * Show `sessionId` in Claude's side bar view, and bring that view forward.
 *
 * This is the pair of steps Claude's own `claude-vscode.editor.open` takes when it
 * routes to the side bar, driven directly instead of through that command — which
 * would consult `preferredLocation` and, worse, rewrite it.
 *
 *  - `activateInSidebar(id)` parks a pending activation and delivers it to
 *    `sidebarComms.notifyActivateSession(id)`. This is what makes the side bar switch
 *    to a specific conversation; without it we could only focus whatever it already
 *    showed. It is a no-op if the side bar view is gone, hence the `sidebarComms`
 *    guard: we only claim success when there is a live view to receive it.
 *  - `reveal()` on the manager's own webview entry for that comms object calls
 *    `WebviewView.show()`. We go through the entry rather than executing
 *    `claudeVSCodeSidebar*.focus` because one provider serves both the primary and
 *    the secondary side bar, so a view id is a guess — and focusing the wrong id
 *    RESOLVES it, spawning a second side bar instead of revealing the live one.
 *    `reveal()` acts on the view that actually exists, in whichever container.
 */
export async function revealClaudeSessionInSidebar(
  sessionId: string,
  log: (msg: string) => void,
): Promise<SidebarRevealOutcome> {
  const fn = `function(){
  try {
    if (!this.sidebarComms) return JSON.stringify({ ok: false, reason: 'no-sidebar' });
    if (typeof this.activateInSidebar !== 'function') return JSON.stringify({ ok: false, reason: 'no-activateInSidebar' });
    this.activateInSidebar(${JSON.stringify(sessionId)}, undefined);
    var revealed = false;
    try {
      if (this.webviews && typeof this.webviews[Symbol.iterator] === 'function') {
        for (var w of this.webviews) {
          if (w && w.comms === this.sidebarComms && typeof w.reveal === 'function') {
            w.reveal(); revealed = true; break;
          }
        }
      }
    } catch (e) {}
    return JSON.stringify({ ok: true, revealed: revealed });
  } catch (e) { return JSON.stringify({ ok: false, reason: String(e) }); }
}`;
  const { raw, diag } = await callOnClaudeManager(fn, log);
  if (typeof raw !== 'string') {
    log(`claude inspector: sidebar reveal unreachable (${diag})`);
    return 'unavailable';
  }
  try {
    const p = JSON.parse(raw) as { ok?: unknown; revealed?: unknown; reason?: unknown };
    if (p.ok !== true) {
      log(`claude inspector: sidebar reveal declined (${String(p.reason)})`);
      return 'unavailable';
    }
    log(`claude inspector: side bar switched to ${sessionId} (revealed=${p.revealed === true})`);
    return p.revealed === true ? 'revealed' : 'activated';
  } catch {
    log('claude inspector: sidebar reveal returned unparseable payload');
    return 'unavailable';
  }
}

/** Debug: dump the Claude manager's own field shape as pretty JSON (or a diag). */
export async function dumpClaudeManagerShape(log: (msg: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(DUMP_FN, log);
  if (typeof raw !== 'string') { return `// could not reach Claude manager: ${diag}`; }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Debug: dump the send + approval shape of every Claude session state as pretty
 *  JSON (or a diag). Read-only — reveals the inject method and approval fields. */
export async function dumpClaudeSendApprovalShape(log: (msg: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(SEND_APPROVAL_PROBE_FN, log);
  if (typeof raw !== 'string') { return `// could not reach Claude manager: ${diag}`; }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
