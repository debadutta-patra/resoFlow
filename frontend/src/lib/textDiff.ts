/** Minimal line diff (longest common subsequence) for comparing method.toml versions. */

export type DiffOp = ' ' | '+' | '-';
export interface DiffLine {
  op: DiffOp;
  text: string;
}

const MAX_CELLS = 4_000_000; // method files are small; beyond this, fall back to a block diff

/** Lines of `before` → `after`: ' ' unchanged, '-' only in before, '+' only in after. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [...a.map(text => ({ op: '-' as const, text })), ...b.map(text => ({ op: '+' as const, text }))];
  }
  // lcs[i][j] = LCS length of a[i:], b[j:]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: '-', text: a[i++] });
    } else {
      out.push({ op: '+', text: b[j++] });
    }
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter(l => l.op === '+').length, removed: lines.filter(l => l.op === '-').length };
}
