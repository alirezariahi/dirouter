import type { SyntheticEvent } from 'react';

export type SubmitEvent = SyntheticEvent<HTMLFormElement>;

/** مقدار متنی فیلد فرم (فایل یا نبودن فیلد = رشتهٔ خالی). */
export function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}
