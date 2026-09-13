import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolveStateDir, resolveWorkspaceRoot, type EnsureDir } from '../supervisionPaths';

/** Records what was created, so a test can assert the returned dir was actually made. */
function recorder(): EnsureDir & { made: string[] } {
  const made: string[] = [];
  const ensure = ((dir: string) => { made.push(dir); }) as EnsureDir & { made: string[] };
  ensure.made = made;
  return ensure;
}

/** A filesystem that refuses, the way `/home/...` does on macOS or a read-only mount does anywhere. */
const refuse: EnsureDir = (dir: string) => {
  throw new Error(`ENOENT: no such file or directory, mkdir '${dir}'`);
};

// A deterministic auto-respond decision must be recorded on a DEFAULT install — no setting
// required. `supervisorStateDir` used to gate every reporting destination, so with it unset the
// rules still fired but nothing reached the activity feed or Telegram. These tests pin the split:
// the state dir always resolves; `explicit` (which is what still gates the AI supervisor) does not.
describe('resolveStateDir', () => {
  const storage = '/home/u/.config/Code/globalStorage/eranra.session-sitter';

  it('falls back to <globalStorage>/state when the setting is unset', () => {
    expect(resolveStateDir(undefined, storage, recorder()))
      .toEqual({ dir: path.join(storage, 'state'), explicit: false });
  });

  it('treats an empty or whitespace-only setting as unset', () => {
    expect(resolveStateDir('', storage, recorder()).explicit).toBe(false);
    expect(resolveStateDir('   ', storage, recorder()).explicit).toBe(false);
    expect(resolveStateDir('   ', storage, recorder()).dir).toBe(path.join(storage, 'state'));
  });

  it('uses the configured dir, trimmed, and marks it explicit', () => {
    expect(resolveStateDir('  /srv/state  ', storage, recorder()))
      .toEqual({ dir: '/srv/state', explicit: true });
  });

  it('creates the dir it returns, so no caller has to', () => {
    const ensure = recorder();
    resolveStateDir('/srv/state', storage, ensure);
    expect(ensure.made).toEqual(['/srv/state']);

    const forDefault = recorder();
    resolveStateDir('', storage, forDefault);
    expect(forDefault.made).toEqual([path.join(storage, 'state')]);
  });

  // The defect this pins: a `supervisorStateDir` copied from another machine (a Linux path on
  // macOS, say) cannot be created, and the `mkdir` threw out of `activate()` — killing the whole
  // extension, panel and Telegram included, with the reason visible only in VS Code's exthost log
  // because the file log lives inside the dir that does not exist.
  it('falls back when a configured dir cannot be created, rather than throwing', () => {
    const resolved = resolveStateDir('/home/eranra/.ai-sessions/state', storage, refuse);

    expect(resolved.dir).toBe(path.join(storage, 'state'));
    expect(resolved.unusable?.configured).toBe('/home/eranra/.ai-sessions/state');
    expect(resolved.unusable?.reason).toContain('mkdir');
  });

  it('does not call a rejected dir explicit, so the AI supervisor stays off', () => {
    // `explicit` means "the user chose this directory". A directory we could not create is not one
    // the user chose, and starting a classifier that writes into global storage instead would be a
    // surprise on top of a misconfiguration.
    expect(resolveStateDir('/home/eranra/.ai-sessions/state', storage, refuse).explicit).toBe(false);
  });

  it('still returns the default dir when even that cannot be created', () => {
    // Nothing left to fall back to, and throwing here would take the extension down for a reason
    // no user can act on. Reporting happens through the log the caller writes.
    expect(resolveStateDir('', storage, refuse).dir).toBe(path.join(storage, 'state'));
  });
});

describe('resolveWorkspaceRoot', () => {
  const storage = '/home/u/.config/Code/globalStorage/eranra.session-sitter';
  const explicitDir = resolveStateDir('/repo/supervisor/.state', storage, recorder());
  const defaultedDir = resolveStateDir('', storage, recorder());

  it('prefers an explicitly configured repo path', () => {
    expect(resolveWorkspaceRoot('/repo', explicitDir, '/ws')).toBe('/repo');
    expect(resolveWorkspaceRoot('  /repo  ', defaultedDir, '/ws')).toBe('/repo');
  });

  it('derives the root from an EXPLICIT state dir', () => {
    expect(resolveWorkspaceRoot('', explicitDir, '/ws')).toBe('/repo/supervisor');
  });

  it('never derives a root from a DEFAULTED state dir — global storage is not a repo', () => {
    expect(resolveWorkspaceRoot('', defaultedDir, '/ws')).toBe('/ws');
  });

  it('returns empty when nothing identifies a root (the supervisor then stays off)', () => {
    expect(resolveWorkspaceRoot(undefined, defaultedDir, undefined)).toBe('');
  });

  it('never derives a root from a state dir that could not be created', () => {
    // The parent of a directory that does not exist is not a repo either — and it was the *state*
    // dir that failed, so pointing the supervisor's knowledge lookup at its parent would compound
    // one misconfiguration into two.
    const rejected = resolveStateDir('/home/eranra/.ai-sessions/state', storage, refuse);
    expect(resolveWorkspaceRoot('', rejected, '/ws')).toBe('/ws');
  });
});
