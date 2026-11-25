/** Budget periods between the API (`daily`…) and the database enum (`DAILY`…); card 33.1. */
import type { BudgetPeriod as DbBudgetPeriod } from '@dirouter/db';

export const BUDGET_PERIODS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const toDbPeriod = (period: BudgetPeriod): DbBudgetPeriod =>
  period.toUpperCase() as DbBudgetPeriod;

export const fromDbPeriod = (period: string): BudgetPeriod => period.toLowerCase() as BudgetPeriod;

/** Sort order of periods, shortest first. */
export const periodRank = (period: string): number =>
  BUDGET_PERIODS.indexOf(period.toLowerCase() as BudgetPeriod);
