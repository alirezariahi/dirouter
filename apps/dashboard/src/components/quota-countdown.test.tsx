/** @vitest-environment jsdom */
/** Quota windows on the Health page (card 32.6): use, and a countdown that ticks to the reset. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { QuotaCountdown } from './quota-countdown';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
  setupI18n('en');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('quota countdown', () => {
  it('shows the use of each window and counts down to its reset', () => {
    render(
      <QuotaCountdown
        lang="en"
        quotas={[
          {
            id: '5h',
            hours: 5,
            limitRequests: 200,
            limitTokens: null,
            limitUsd: null,
            used: { requests: 200, tokens: 9000, usd: '0' },
            resetAt: '2026-11-25T15:00:00.000Z',
            exhausted: true,
          },
          {
            id: 'week',
            hours: 168,
            limitRequests: null,
            limitTokens: null,
            limitUsd: '100',
            used: { requests: 0, tokens: 0, usd: '0' },
            resetAt: null,
            exhausted: false,
          },
        ]}
      />,
    );
    const five = screen.getByTestId('quota-5h');
    expect(five.textContent).toContain('5h window (5 h)');
    expect(five.textContent).toContain('200 of 200 requests');
    expect(five.textContent).toContain('used up');
    expect(screen.getByTestId('quota-countdown').textContent).toBe('resets in 5:00:00');
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId('quota-countdown').textContent).toBe('resets in 4:58:59');
    expect(screen.getByTestId('quota-week').textContent).toContain(
      'not started; the first request starts it',
    );
  });

  it('renders nothing without windows', () => {
    const { container } = render(<QuotaCountdown lang="en" quotas={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
