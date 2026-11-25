/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { i18n, setupI18n } from '../i18n';
import { RouteDecisionView } from './route-decision-view';

beforeEach(async () => {
  setupI18n('en');
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

describe('routing decision in the log details', () => {
  it('shows the data policy and why each target was removed (card 32.5)', () => {
    render(
      <RouteDecisionView
        decision={{
          dataPolicy: { requireZdr: true, allowedRegions: ['eu'] },
          skipped: [
            { modelId: 'm-beta', credentialId: 'k', reason: 'not_zdr' },
            { modelId: 'm-us', reason: 'region_not_allowed' },
          ],
        }}
      />,
    );
    const section = screen.getByTestId('log-route-decision');
    expect(section.textContent).toContain('Data policy: ZDR only · Allowed regions: eu');
    expect(section.textContent).toContain('m-beta — Provider has no zero data retention (ZDR)');
    expect(section.textContent).toContain("m-us — Provider's region is not allowed");
  });

  it('renders nothing for a request without a decision', () => {
    const { container } = render(<RouteDecisionView decision={null} />);
    expect(container.textContent).toBe('');
  });

  it('shows the service tier and the model suffixes (card 31.5)', () => {
    render(<RouteDecisionView decision={{ suffixes: ['floor', 'online'] }} serviceTier="flex" />);
    const section = screen.getByTestId('log-route-decision');
    expect(section.textContent).toContain('Service tier: flex');
    expect(section.textContent).toContain('Model suffixes: :floor :online');
  });
});
