/**
 * The key form's limits on single models (card 33.3): rows of the form, read back from FormData.
 * A row edits one budget (period and dollars); the entry's other budgets are kept as they are.
 */
import type {
  KeysControllerCreateBodyModelLimitsItem,
  KeysControllerList200ItemModelLimitsItem,
} from '../api/generated';
import { text } from './form';
import { type Period, PERIODS } from './scope-limits';

export type ModelLimitBody = KeysControllerCreateBodyModelLimitsItem;
export type ModelLimitView = KeysControllerList200ItemModelLimitsItem;
type BudgetBody = NonNullable<ModelLimitBody['budgets']>[number];

export const RATE_FIELDS = ['rpm', 'tpm', 'inputTpm', 'outputTpm'] as const;

export interface ModelLimitRow {
  model: string;
  rpm: string;
  tpm: string;
  inputTpm: string;
  outputTpm: string;
  period: Period;
  usd: string;
  /** The entry's budgets the row does not show, kept on save. */
  keep: BudgetBody[];
}

const value = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export function rowsOf(entries: readonly ModelLimitView[] = []): ModelLimitRow[] {
  return entries.map((e) => {
    const shown = e.budgets.find((b) => b.limitUsd !== null);
    return {
      model: e.model,
      rpm: value(e.rpm),
      tpm: value(e.tpm),
      inputTpm: value(e.inputTpm),
      outputTpm: value(e.outputTpm),
      period: shown?.period ?? 'daily',
      usd: shown?.limitUsd ?? '',
      keep: e.budgets
        .filter((b) => b !== shown)
        .map((b) => ({
          period: b.period,
          ...(b.limitUsd !== null ? { limitUsd: b.limitUsd } : {}),
          ...(b.limitTokens !== null ? { limitTokens: b.limitTokens } : {}),
          alertThresholds: b.alertThresholds,
        })),
    };
  });
}

export const emptyRow = (): ModelLimitRow => ({
  model: '',
  rpm: '',
  tpm: '',
  inputTpm: '',
  outputTpm: '',
  period: 'daily',
  usd: '',
  keep: [],
});

const int = (v: string) => (v.trim() ? Number(v.trim()) : null);

/** The rows of a submitted form as the keys API takes them; rows without a model are dropped. */
export function modelLimitsFrom(form: FormData): ModelLimitBody[] {
  const count = Number(text(form, 'modelLimitCount') || '0');
  const out: ModelLimitBody[] = [];
  for (let i = 0; i < count; i++) {
    const field = (name: string) => text(form, `modelLimit.${String(i)}.${name}`).trim();
    const model = field('model');
    if (!model) continue;
    const period = (PERIODS as readonly string[]).includes(field('period'))
      ? (field('period') as Period)
      : 'daily';
    const usd = field('usd');
    let keep: BudgetBody[];
    try {
      keep = JSON.parse(field('keep') || '[]') as BudgetBody[];
    } catch {
      keep = [];
    }
    const budgets = [
      ...keep.filter((b) => !usd || b.period !== period),
      ...(usd ? [{ period, limitUsd: usd }] : []),
    ];
    out.push({
      model,
      rpm: int(field('rpm')),
      tpm: int(field('tpm')),
      inputTpm: int(field('inputTpm')),
      outputTpm: int(field('outputTpm')),
      budgets,
    });
  }
  return out;
}
