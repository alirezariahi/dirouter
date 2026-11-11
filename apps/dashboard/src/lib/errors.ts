/** Exact, translated error message derived from the stable problem+json code (card 7.2). */
import type { TFunction } from 'i18next';

import { ApiError } from './api';

export function errorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    const code = error.code ?? '';
    const key = `errors.${code}`;
    const translated = t(key, { defaultValue: '' });
    if (translated) return translated;
    if (error.problem.errors?.length)
      return error.problem.errors
        .map((e) => `${t(`fields.${e.path}`, { defaultValue: e.path })}: ${e.message}`)
        .join('، ');
    return error.message;
  }
  if (error instanceof TypeError) return t('errors.network');
  return error instanceof Error ? error.message : String(error);
}

/** Error for a specific field from a validation error. */
export function fieldError(error: unknown, path: string): string | undefined {
  return error instanceof ApiError
    ? error.problem.errors?.find((e) => e.path === path)?.message
    : undefined;
}
