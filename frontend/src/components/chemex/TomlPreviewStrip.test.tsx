/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TomlPreviewStrip } from './TomlEditorParts';

afterEach(cleanup);

describe('TomlPreviewStrip diff vs last committed run', () => {
  it('is offered only with a baseline and shows added/removed lines', () => {
    const { rerender } = render(<TomlPreviewStrip fileName="parameters.toml" downloadName="p.toml" toml={'[GLOBAL]\nPB = 0.1\n'} badge="0" />);
    expect(screen.queryByRole('button', { name: /Diff vs last committed run/ })).toBeNull();

    rerender(
      <TomlPreviewStrip
        fileName="parameters.toml"
        downloadName="p.toml"
        toml={'[GLOBAL]\nPB = 0.1\nKEX_AB = 300\n'}
        badge="0"
        baseline={'[GLOBAL]\nPB = 0.05\n'}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Diff vs last committed run/ }));
    const diff = screen.getByTestId('preview-diff').textContent ?? '';
    expect(diff).toContain('-PB = 0.05');
    expect(diff).toContain('+PB = 0.1');
    expect(diff).toContain('+KEX_AB = 300');
    expect(screen.getByText('+2')).toBeDefined();
    expect(screen.getByText('−1')).toBeDefined();
  });
});
