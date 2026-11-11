/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { VirtualTable } from './virtual-table';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('windows 100,000 real rows and reaches the final row without growing the DOM', async () => {
  const rows = Array.from({ length: 100_000 }, (_, index) => ({
    id: String(index),
    label: `Request ${String(index)}`,
  }));
  const onRow = vi.fn();
  render(
    <VirtualTable
      rows={rows}
      columns={[{ key: 'label', label: 'Request', render: (row) => row.label }]}
      rowKey={(row) => row.id}
      onRow={onRow}
    />,
  );
  const viewport = screen.getByTestId('virtual-log-table');
  expect(screen.getByText('Request 0')).toBeTruthy();
  expect(screen.getAllByTestId('log-row').length).toBeLessThan(50);
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 480 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 4_800_000 });
  fireEvent.scroll(viewport, { target: { scrollTop: 4_799_520 } });
  await waitFor(() => {
    expect(screen.getByText('Request 99999')).toBeTruthy();
  });
  expect(screen.getAllByTestId('log-row').length).toBeLessThan(50);
  expect(screen.queryByText('Request 0')).toBeNull();
  const last = screen.getByText('Request 99999').closest('tr');
  if (!last) throw new Error('Missing final row');
  fireEvent.keyDown(last, { key: ' ' });
  expect(onRow).toHaveBeenCalledWith(rows[99999]);
});
