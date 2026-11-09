import { describe, expect, it } from 'vitest';
import { checkConstraintRhs, formatSelector, parseConstraint, parseSelector } from './methodGrammar';

describe('v2 selector grammar (mirror of ChemEx parse_strict_selector)', () => {
  it.each(['DW_AB', 'R2_A, NUC->G23N, B0->800.13MHz, T->23C', 'R1_A, B0->800.13MHz', 'DW_AB, NUC->N', 'R1_A, [P]->0.001M, D2O->0.1', 'pb'])(
    'accepts docs selector %s',
    text => expect(parseSelector(text).error).toBeUndefined()
  );

  it.each([
    ['DW_AB, NUC->26N, NUC->28N', 'Duplicate selector qualifier NUC', 'NUC->28N'],
    ['DW_AB, FOO->1', 'Unknown or malformed selector qualifier', 'FOO->1'],
    ['DW_AB,', 'Empty selector qualifier', ''],
    ['DW_AB, NUC->26N extra', 'Invalid NUC spin-system', 'NUC->26N extra'],
    ['R1_A, D2O->1.5', 'D2O must be between 0 and 1', 'D2O->1.5'],
    ['R1_A, B0->-5MHz', 'B0 must be nonnegative', 'B0->-5MHz'],
    ['R1_A, T->25K', 'Invalid value or unit for selector qualifier T', 'T->25K'],
    ['2DW', 'Invalid parameter-name token', '2DW'],
  ])('rejects %s', (text, message, span) => {
    const { error } = parseSelector(text);
    expect(error?.message).toContain(message);
    expect(text.slice(error!.start, error!.end)).toBe(span);
  });

  it('formats canonically', () => {
    expect(formatSelector(parseSelector(' dw_ab ,nuc->G24N-H ').selector!)).toBe('DW_AB, NUC->G24N-H');
  });
});

describe('v2 constraint grammar (mirror of ChemEx parse_constraint)', () => {
  it.each([
    '[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]',
    '[R1_B] = 0.5 * [R1_A]',
    '[R2_B, NUC->N] = [R2_A, NUC->N]',
    '[R2_B] = 0.5 * ([R2_A] + 1.0)',
    '[R2_B] = -[R2_A] / 2e-1',
    '[R1_B, [P]->0.1M] = [R1_A, [P]->0.1M]',
  ])('accepts %s', text => expect(parseConstraint(text).error).toBeUndefined());

  it.each([
    ['[R2_B] = [R2_A] ** 2', "unsupported token '**'"],
    ['[R2_B] = sqrt([R2_A])', "unsupported token 'sqrt'"],
    ['[R2_B] = 2[R2_A]', 'not a valid scalar expression'],
    ['[R2_B] = ([R2_A]', "missing ')'"],
    ['[R2_B] = [R2_A', 'Unclosed parameter selector'],
    ['[R2_B] = [R2_A, FOO->1]', 'Unknown or malformed selector qualifier'],
    ['R2_B = [R2_A]', 'left side must be one bracketed selector'],
    ['[R2_B] = [R2_A] = 1', "exactly one '='"],
    ['[R2_B] =', 'right side cannot be empty'],
    ['[R2_B] = [R2_A] +', 'expression ends early'],
  ])('rejects %s', (text, message) => {
    expect(parseConstraint(text).error?.message).toContain(message);
  });

  it('locates errors and references in the right-hand side', () => {
    const rhs = ' 0.5 * [R1_A, NUC->26N] + [R2_A]';
    const { references, error } = checkConstraintRhs(rhs);
    expect(error).toBeUndefined();
    expect(references.map(r => rhs.slice(r.start, r.end))).toEqual(['[R1_A, NUC->26N]', '[R2_A]']);
    const bad = checkConstraintRhs('[R1_A] ^ 2');
    expect('[R1_A] ^ 2'.slice(bad.error!.start, bad.error!.end)).toBe('^');
  });
});

describe('bare parameter names on a right-hand side', () => {
  it('says to bracket them and suggests the fix', () => {
    const rhs = '0.5 * R2_A';
    const { error } = checkConstraintRhs(rhs);
    expect(error?.message).toBe('Parameter references go in brackets: write [R2_A] instead of R2_A');
    expect(rhs.slice(error!.start, error!.end)).toBe('R2_A');
    expect(error?.suggestion).toBe('[R2_A]');
    expect(checkConstraintRhs(rhs.slice(0, error!.start) + error!.suggestion + rhs.slice(error!.end)).error).toBeUndefined();
    expect(checkConstraintRhs('sqrt([R2_A])').error?.message).toContain("unsupported token 'sqrt'");
  });
});
