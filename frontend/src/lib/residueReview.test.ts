import { describe, it, expect } from 'vitest';
import {
  EMPTY_REVIEW,
  buildBrowserRows,
  gapReason,
  isFlagged,
  noteOf,
  normalizeReview,
  normalizeReviewBook,
  pushUndo,
  reviewProgress,
  reviewToCsv,
  reviewToToml,
  rowForParam,
  setNote,
  setStatus,
  shortcutFor,
  statusOf,
  storedStatusOf,
  stepRow,
  toggleFlag,
} from './residueReview';

describe('review state', () => {
  it('exclusion wins over a stored status; unknown residues are unreviewed', () => {
    const r = setStatus(EMPTY_REVIEW, '14N', 'accepted');
    expect(statusOf(r, '14N', false)).toBe('accepted');
    expect(statusOf(r, '14N', true)).toBe('excluded');
    expect(statusOf(r, '15N', false)).toBe('unreviewed');
  });

  it('addresses residues through SpinSystemKey, not string equality', () => {
    let r = setStatus(EMPTY_REVIEW, 'G14N', 'no_excited_state');
    expect(statusOf(r, '14N', false)).toBe('no_excited_state');
    r = setStatus(r, '14N', 'accepted'); // replaces, does not duplicate
    expect(Object.keys(r.statuses)).toEqual(['14N']);
    r = setNote(r, 'GLY14N', 'shoulder');
    expect(noteOf(r, '14N')).toBe('shoulder');
    r = toggleFlag(r, '14N');
    expect(isFlagged(r, 'G14N')).toBe(true);
    r = toggleFlag(r, 'G14N');
    expect(isFlagged(r, '14N')).toBe(false);
  });

  it('empty notes are removed', () => {
    const r = setNote(setNote(EMPTY_REVIEW, '3N', 'x'), '3N', '   ');
    expect(r.notes).toEqual({});
  });

  it('counts reviewed residues for the progress label', () => {
    const r = setStatus(setStatus(EMPTY_REVIEW, '1N', 'accepted'), '2N', 'no_excited_state');
    const excluded = new Set(['3N']);
    const p = reviewProgress(['1N', '2N', '3N', '4N'], id => statusOf(r, id, excluded.has(id)));
    expect(p).toEqual({ reviewed: 3, total: 4 });
  });

  it('normalizes saved state, dropping malformed entries', () => {
    expect(normalizeReview({ statuses: { a: 'accepted', b: 'bogus' }, notes: { a: 'n', b: ' ', c: 3 }, flags: { a: true, b: 'yes' } }))
      .toEqual({ statuses: { a: 'accepted' }, notes: { a: 'n' }, flags: { a: true } });
    expect(normalizeReviewBook({ pick_cest: {}, other: {} })).toEqual({ pick_cest: { statuses: {}, notes: {}, flags: {} } });
    expect(normalizeReview(null)).toEqual(EMPTY_REVIEW);
  });
});

describe('browser rows', () => {
  it('sorts by residue number and inserts gap rows with reasons', () => {
    // Sequence MKPAG: residue 3 is a proline.
    const rows = buildBrowserRows(
      [{ id: '5N' }, { id: '1N' }, { id: '2N' }],
      { sequence: 'MKPAG', offset: 0, reasons: { 4: 'unassigned' } }
    );
    expect(rows.map(r => [r.id, r.present, r.gapReason])).toEqual([
      ['1N', true, undefined],
      ['2N', true, undefined],
      ['gap:3', false, 'proline'],
      ['gap:4', false, 'unassigned'],
      ['5N', true, undefined],
    ]);
    expect(rows[2].label).toBe('P3');
  });

  it('without a sequence, gaps read "no data"', () => {
    expect(gapReason(7)).toBe('no data');
    expect(buildBrowserRows([{ id: '1N' }, { id: '3N' }])[1]).toMatchObject({ present: false, gapReason: 'no data' });
  });

  it('respects the sequence offset', () => {
    expect(gapReason(13, { sequence: 'MKPAG', offset: 10 })).toBe('proline');
  });

  it('resolves ?res= values and steps over gaps', () => {
    const rows = buildBrowserRows([{ id: 'G1N' }, { id: '3N' }]);
    expect(rowForParam(rows, '1N')).toBe('G1N');
    expect(rowForParam(rows, '3N')).toBe('3N');
    expect(rowForParam(rows, '2N')).toBeUndefined();
    expect(rowForParam(rows, null)).toBeUndefined();
    expect(stepRow(rows, 'G1N', 1)).toBe('3N');
    expect(stepRow(rows, '3N', 1)).toBe('3N');
    expect(stepRow(rows, '3N', -1)).toBe('G1N');
    expect(stepRow(rows, null, 1)).toBe('G1N');
  });
});

describe('shortcuts', () => {
  const input = { tagName: 'INPUT', type: 'text' } as unknown as EventTarget;
  const checkbox = { tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget;
  const textarea = { tagName: 'TEXTAREA' } as unknown as EventTarget;

  it('maps keys to actions', () => {
    expect(shortcutFor({ key: 'ArrowLeft' })).toBe('prev');
    expect(shortcutFor({ key: 'ArrowRight' })).toBe('next');
    expect(shortcutFor({ key: 'Enter' })).toBe('accept');
    expect(shortcutFor({ key: 'x' })).toBe('exclude');
    expect(shortcutFor({ key: 'N' })).toBe('no_excited');
    expect(shortcutFor({ key: 'z', ctrlKey: true })).toBe('undo');
    expect(shortcutFor({ key: 'z', metaKey: true })).toBe('undo');
  });

  it('A … F only arm picking where enabled; U resets the status', () => {
    expect(shortcutFor({ key: 'a' })).toBeNull();
    expect(shortcutFor({ key: 'a' }, { armKeys: true })).toBe('arm_a');
    expect(shortcutFor({ key: 'B' }, { armKeys: true })).toBe('arm_b');
    expect(shortcutFor({ key: 'c' }, { armKeys: true })).toBe('arm_c');
    expect(shortcutFor({ key: 'f' }, { armKeys: true })).toBe('arm_f');
    expect(shortcutFor({ key: 'g' }, { armKeys: true })).toBeNull();
    expect(shortcutFor({ key: 'u' })).toBe('clear_status');
  });

  it('an explicit reset is stored and normalised as unreviewed', () => {
    const r = setStatus(setStatus(EMPTY_REVIEW, '4N', 'accepted'), '4N', 'unreviewed');
    expect(statusOf(r, '4N', false)).toBe('unreviewed');
    expect(storedStatusOf(r, '4N')).toBe('unreviewed');
    expect(storedStatusOf(r, '5N')).toBeUndefined();
    expect(normalizeReview({ statuses: { '4N': 'unreviewed' } }).statuses).toEqual({ '4N': 'unreviewed' });
  });

  it('is ignored while typing and with modifiers', () => {
    expect(shortcutFor({ key: 'x', target: input })).toBeNull();
    expect(shortcutFor({ key: 'z', ctrlKey: true, target: textarea })).toBeNull();
    expect(shortcutFor({ key: 'x', target: checkbox })).toBe('exclude');
    expect(shortcutFor({ key: 'x', ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: 'ArrowLeft', altKey: true })).toBeNull();
  });

  it('caps the undo stack', () => {
    let s = pushUndo([], { label: '0', undo: () => {} }, 3);
    for (let i = 1; i < 5; i++) s = pushUndo(s, { label: String(i), undo: () => {} }, 3);
    expect(s.map(e => e.label)).toEqual(['2', '3', '4']);
  });
});

describe('export', () => {
  const rows = [
    { residue: '14N', status: 'accepted' as const, flagged: true, note: 'dip, "weak"', values: { cs_a: 118.25, cs_b: null } },
    { residue: '15N', status: 'unreviewed' as const, flagged: false, note: '', values: { cs_a: undefined, cs_b: 120 } },
  ];
  const masks = [{ experiment: '600MHz_67hz', plane: 3, offset_ppm: 117.5 }];

  it('writes residue rows then mask rows to CSV, quoting where needed', () => {
    const csv = reviewToCsv(rows, ['cs_a', 'cs_b'], masks).trim().split('\n');
    expect(csv[0]).toBe('kind,residue,status,flagged,note,cs_a,cs_b,experiment,plane,offset_ppm');
    expect(csv[1]).toBe('residue,14N,accepted,true,"dip, ""weak""",118.25,,,,');
    expect(csv[2]).toBe('residue,15N,unreviewed,false,,,120,,,');
    expect(csv[3]).toBe('mask,,,,,,,600MHz_67hz,3,117.5');
  });

  it('writes valid TOML tables, skipping missing values', () => {
    const toml = reviewToToml(rows, masks, { page: 'Pick CEST' });
    expect(toml).toContain('page = "Pick CEST"');
    expect(toml).toContain('[residues."14N"]\nstatus = "accepted"\nflagged = true\nnote = "dip, \\"weak\\""\ncs_a = 118.25\n');
    expect(toml).toContain('[residues."15N"]\nstatus = "unreviewed"\nflagged = false\ncs_b = 120\n');
    expect(toml).not.toContain('cs_b = null');
    expect(toml).toContain('[[masks]]\nexperiment = "600MHz_67hz"\nplane = 3\noffset_ppm = 117.5');
  });
});
