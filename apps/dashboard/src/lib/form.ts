import type { SyntheticEvent } from 'react';

export type SubmitEvent = SyntheticEvent<HTMLFormElement>;

/** Text value of a form field (a file or a missing field = empty string). */
export function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}
