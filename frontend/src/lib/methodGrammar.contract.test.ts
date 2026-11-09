/**
 * Contract: the TS grammar mirror gives the same verdict as ChemEx on the shared
 * cases (backend/tests/test_method_grammar_contract.py checks ChemEx itself).
 */
import { describe, expect, it } from 'vitest';
import { parseConstraint, parseSelector } from './methodGrammar';
import casesJson from '../../../backend/tests/fixtures/method_contract/grammar_cases.json?raw';

const cases = JSON.parse(casesJson) as { selectors: Array<{ text: string; valid: boolean }>; constraints: Array<{ text: string; valid: boolean }> };

describe('grammar contract with ChemEx', () => {
  it.each(cases.selectors)('selector "$text" valid=$valid', ({ text, valid }) => {
    expect(parseSelector(text).error === undefined).toBe(valid);
  });
  it.each(cases.constraints)('constraint "$text" valid=$valid', ({ text, valid }) => {
    expect(parseConstraint(text).error === undefined).toBe(valid);
  });
});
