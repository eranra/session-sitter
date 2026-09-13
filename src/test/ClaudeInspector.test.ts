import { describe, it, expect, vi } from 'vitest';

// ClaudeInspector imports 'vscode' and 'inspector' at load; stub the vscode part
// unused by the pure helper under test.
vi.mock('vscode', () => ({ extensions: { getExtension: vi.fn() } }));

import { parseClaudeOpenState, statesWithoutPanel } from '../agents/ClaudeInspector';

const EMPTY = { open: [], panels: [], states: [], active: null, sidebar: false };

describe('parseClaudeOpenState', () => {
  it('keeps panels and states apart, and derives open as their union', () => {
    // `panels` = sessions open as editor panels; `states` = every session the
    // manager holds (side bar included). The split is what tells us WHERE a
    // session lives, so it must survive parsing.
    expect(parseClaudeOpenState('{"panels":["a"],"states":["a","b"],"active":"a"}')).toEqual({
      open: ['a', 'b'], panels: ['a'], states: ['a', 'b'], active: 'a', sidebar: false,
    });
  });

  it('reports a side bar session as a state with no panel', () => {
    // The reported bug: this session is live but has no editor panel. Callers must
    // be able to see that, instead of a merged set that looks identical to "closed".
    expect(parseClaudeOpenState('{"panels":[],"states":["sidebar-sess"],"active":null}')).toEqual({
      open: ['sidebar-sess'], panels: [], states: ['sidebar-sess'], active: null, sidebar: false,
    });
  });

  it('dedupes and drops empty/non-string entries in both arrays', () => {
    expect(parseClaudeOpenState('{"panels":["a","a","",1,null],"states":["b","b",false],"active":null}'))
      .toEqual({ open: ['a', 'b'], panels: ['a'], states: ['b'], active: null, sidebar: false });
  });

  it('active is null when missing or not a non-empty string', () => {
    expect(parseClaudeOpenState('{"panels":[],"states":[]}')).toEqual(EMPTY);
    expect(parseClaudeOpenState('{"panels":[],"states":[],"active":""}')).toEqual(EMPTY);
  });

  it('treats missing arrays as empty rather than throwing', () => {
    expect(parseClaudeOpenState('{}')).toEqual(EMPTY);
    expect(parseClaudeOpenState('{"panels":"nope","states":42}')).toEqual(EMPTY);
  });

  it('returns empty state for non-string input (inspector failure)', () => {
    expect(parseClaudeOpenState(undefined)).toEqual(EMPTY);
  });

  it('returns empty state for malformed JSON', () => {
    expect(parseClaudeOpenState('nope')).toEqual(EMPTY);
  });

  it('carries the side bar flag, which is what distinguishes "in the side bar" from "closed"', () => {
    // `states` with no panel means the manager holds the session; only `sidebar` says
    // there is a live side bar view it could be showing IN. Both are needed to route.
    const state = parseClaudeOpenState('{"panels":[],"states":["s"],"active":null,"sidebar":true}');
    expect(state.sidebar).toBe(true);
    expect(state.states).toEqual(['s']);
  });

  it('defaults the side bar flag to false for anything but a literal true', () => {
    // A missing flag is an older Claude or a failed read. Defaulting to false keeps the
    // safe branch (open by id) rather than aiming at a side bar that may not exist.
    expect(parseClaudeOpenState('{"panels":[],"states":["s"]}').sidebar).toBe(false);
    expect(parseClaudeOpenState('{"panels":[],"states":["s"],"sidebar":"yes"}').sidebar).toBe(false);
    expect(parseClaudeOpenState('{"panels":[],"states":["s"],"sidebar":1}').sidebar).toBe(false);
  });
});

describe('statesWithoutPanel', () => {
  // `open` is panels ∪ states, so a session with state but no panel counts as held by this window —
  // and therefore active, at any age, with nothing to age it out. Whether Claude drops a session's
  // state when its panel closes is undocumented and was not reproducible, so the union is unchanged
  // and this exists to make the question answerable from a log.
  it('names the ids that only state accounts for', () => {
    const state = parseClaudeOpenState('{"panels":["a"],"states":["a","b","c"],"active":"a"}');
    expect(statesWithoutPanel(state)).toEqual(['b', 'c']);
  });

  it('is empty when every state has a panel', () => {
    const state = parseClaudeOpenState('{"panels":["a","b"],"states":["a","b"],"active":"a"}');
    expect(statesWithoutPanel(state)).toEqual([]);
  });

  it('does not complain about a panel with no state', () => {
    // The union direction that is not suspicious: a panel is open, so the session is open.
    const state = parseClaudeOpenState('{"panels":["a","b"],"states":["a"],"active":"a"}');
    expect(statesWithoutPanel(state)).toEqual([]);
  });

  it('is empty for an unreachable manager', () => {
    expect(statesWithoutPanel(parseClaudeOpenState(undefined))).toEqual([]);
  });
});
