/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { Empty, ErrorState, Loading } from './states';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('shared UI states', () => {
  it('shows default and explicit loading/empty content', () => {
    const { rerender } = render(<Loading />);
    expect(screen.getByText('state.loading')).toBeTruthy();
    rerender(<Empty>Nothing here</Empty>);
    expect(screen.getByText('state.empty')).toBeTruthy();
    expect(screen.getByText('Nothing here')).toBeTruthy();
    rerender(<Empty title="Empty" />);
    expect(screen.getByText('Empty')).toBeTruthy();
  });

  it('shows API details and supports retries', () => {
    const retry = vi.fn();
    const { rerender } = render(
      <ErrorState
        error={new ApiError({ status: 500, title: 'Failed', requestId: 'req_1' })}
        onRetry={retry}
      />,
    );
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('req_1')).toBeTruthy();
    screen.getByRole('button').click();
    expect(retry).toHaveBeenCalledOnce();
    rerender(<ErrorState error={new Error('plain')} />);
    expect(screen.getByText('plain')).toBeTruthy();
    rerender(<ErrorState error="unknown" />);
    expect(screen.getByText('unknown')).toBeTruthy();
  });
});
