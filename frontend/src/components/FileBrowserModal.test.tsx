/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import FileBrowserModal from './FileBrowserModal';

const listing = {
  path: '/data/projects',
  display_path: '/data/projects',
  items: [
    { name: 'alpha', path: '/data/projects/alpha', display_path: '/data/projects/alpha', is_dir: true, size: null, modified: 1700000000 },
    { name: 'beta', path: '/data/projects/beta', display_path: '/data/projects/beta', is_dir: true, size: null, modified: 1700000000 },
  ],
  roots: [{ name: 'projects', path: '/data/projects', display_path: '/data/projects' }],
};

const get = vi.fn();
const post = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

const renderModal = (props: Partial<React.ComponentProps<typeof FileBrowserModal>> = {}) =>
  render(
    <FileBrowserModal
      isOpen
      onClose={vi.fn()}
      onSelect={vi.fn()}
      selectType="directory"
      {...props}
    />
  );

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: listing });
});

afterEach(() => {
  cleanup();
});

const listingWithParent = {
  ...listing,
  items: [
    { name: '..', path: '/data', display_path: '/data', is_dir: true },
    ...listing.items,
  ],
};

describe('FileBrowserModal keyboard handling', () => {
  it('first ArrowDown lands on a real entry, not the parent row', async () => {
    get.mockResolvedValue({ data: listingWithParent });
    const onSelect = vi.fn();
    renderModal({ onSelect });
    await screen.findByText('alpha');

    fireEvent.keyDown(document.activeElement || document.body, { key: 'ArrowDown' });

    // Something must actually be selected; landing on '..' selects nothing and
    // reads to the user as the shortcut doing nothing at all.
    fireEvent.click(screen.getByText('Select'));
    expect(onSelect).toHaveBeenCalledWith('/data/projects/alpha');
  });

  it('Enter after one ArrowDown must not navigate to the parent', async () => {
    get.mockResolvedValue({ data: listingWithParent });
    renderModal();
    await screen.findByText('alpha');
    get.mockClear();

    fireEvent.keyDown(document.activeElement || document.body, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Enter' });

    const navigatedTo = get.mock.calls.map(
      c => (c[1] as { params?: { path?: string } } | undefined)?.params?.path
    );
    expect(navigatedTo).not.toContain('/data');
  });

  it('arrow keys still reach the list after typing in the filter', async () => {
    get.mockResolvedValue({ data: listingWithParent });
    const onSelect = vi.fn();
    renderModal({ onSelect });
    await screen.findByText('alpha');

    const filter = screen.getByPlaceholderText('Filter this folder...');
    fireEvent.change(filter, { target: { value: 'alp' } });
    filter.focus();
    fireEvent.keyDown(filter, { key: 'ArrowDown' });

    fireEvent.click(screen.getByText('Select'));
    expect(onSelect).toHaveBeenCalledWith('/data/projects/alpha');
  });

  it('renders the listing it fetched', async () => {
    renderModal();
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
  });

  it('puts focus somewhere inside the modal so key events are reachable', async () => {
    const { container } = renderModal();
    await screen.findByText('alpha');
    const overlay = container.firstElementChild as HTMLElement;
    // The handler lives on the overlay; a focused node outside it never
    // bubbles there, and every shortcut silently does nothing.
    expect(document.activeElement).not.toBe(document.body);
    expect(overlay.contains(document.activeElement)).toBe(true);
  });

  it('moves the selection with ArrowDown', async () => {
    renderModal();
    await screen.findByText('alpha');

    fireEvent.keyDown(document.activeElement || document.body, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(screen.getByTitle('/data/projects/alpha')).toBeTruthy();
    });
    // The footer echoes whatever is selected.
    const footers = screen.getAllByText('/data/projects/alpha');
    expect(footers.length).toBeGreaterThan(0);
  });

  it('works when the modal is mounted closed and opened later (real usage)', async () => {
    // Every call site keeps the modal mounted and toggles isOpen, rather than
    // conditionally rendering it.
    const onClose = vi.fn();
    const { rerender, container } = render(
      <FileBrowserModal
        isOpen={false}
        onClose={onClose}
        onSelect={vi.fn()}
        selectType="directory"
      />
    );

    rerender(
      <FileBrowserModal
        isOpen
        onClose={onClose}
        onSelect={vi.fn()}
        selectType="directory"
      />
    );

    await screen.findByText('alpha');
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByText('alpha');

    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not hijack keys typed into the filter box', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await screen.findByText('alpha');

    const filter = screen.getByPlaceholderText('Filter this folder...');
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
