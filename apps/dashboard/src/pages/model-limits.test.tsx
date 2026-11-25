/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelLimitsField } from '../components/model-limits-field';
import { i18n, setupI18n } from '../i18n';
import { modelLimitsFrom } from '../lib/model-limits';

beforeEach(async () => {
  setupI18n('en');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
});

const read = () => modelLimitsFrom(new FormData(screen.getByTestId<HTMLFormElement>('form')));

describe('limits on single models in the key form (card 33.3)', () => {
  it('adds a capped expensive model and leaves the others out', () => {
    render(
      <form data-testid="form">
        <ModelLimitsField />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    const row = within(screen.getByTestId('model-limit-0'));
    fireEvent.change(row.getByLabelText('Model, alias or combo'), {
      target: { value: 'openai/gpt-5' },
    });
    fireEvent.change(row.getByLabelText('Requests per minute'), { target: { value: '10' } });
    fireEvent.change(row.getByLabelText('Output tokens per minute'), { target: { value: '5000' } });
    fireEvent.change(row.getByLabelText('Budget period'), { target: { value: 'weekly' } });
    fireEvent.change(row.getByLabelText('Cost limit (USD)'), { target: { value: '25' } });
    // An empty row is dropped.
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    expect(read()).toEqual([
      {
        model: 'openai/gpt-5',
        rpm: 10,
        tpm: null,
        inputTpm: null,
        outputTpm: 5000,
        budgets: [{ period: 'weekly', limitUsd: '25' }],
      },
    ]);
  });

  it('keeps the budgets a row does not show, and removes a row', () => {
    render(
      <form data-testid="form">
        <ModelLimitsField
          initial={[
            {
              model: 'pricey',
              rpm: null,
              tpm: null,
              inputTpm: 1000,
              outputTpm: null,
              maxConcurrency: null,
              budgets: [
                {
                  id: 'b1',
                  period: 'daily',
                  limitUsd: '5',
                  limitTokens: null,
                  alertThresholds: [100],
                },
                {
                  id: 'b2',
                  period: 'yearly',
                  limitUsd: null,
                  limitTokens: 9000,
                  alertThresholds: [80],
                },
              ],
            },
            {
              model: 'smart',
              rpm: 3,
              tpm: null,
              inputTpm: null,
              outputTpm: null,
              maxConcurrency: null,
              budgets: [],
            },
          ]}
        />
      </form>,
    );
    fireEvent.change(
      within(screen.getByTestId('model-limit-0')).getByLabelText('Cost limit (USD)'),
      {
        target: { value: '6' },
      },
    );
    fireEvent.click(
      within(screen.getByTestId('model-limit-1')).getByRole('button', { name: 'Remove' }),
    );
    expect(read()).toEqual([
      {
        model: 'pricey',
        rpm: null,
        tpm: null,
        inputTpm: 1000,
        outputTpm: null,
        budgets: [
          { period: 'yearly', limitTokens: 9000, alertThresholds: [80] },
          { period: 'daily', limitUsd: '6' },
        ],
      },
    ]);
  });
});
