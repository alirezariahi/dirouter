/** Types shared by the A2A agent and its push notifications (cards 20.3, 28.2). */

export type Version = '1.0' | '0.3';
export type State = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected';

export const TERMINAL: ReadonlySet<State> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

/** Version-neutral task kept in the store. */
export interface StoredTask {
  id: string;
  contextId: string;
  state: State;
  statusText?: string;
  answer?: string;
  history: { role: 'user' | 'agent'; text: string; messageId: string }[];
  timestamp: string;
  owner: { organizationId: string; projectId: string };
}

export class A2aError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
