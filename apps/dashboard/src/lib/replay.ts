/**
 * Replay hand-off (card 24.1): the Log Explorer stores the conversation of a captured request and
 * the playground takes it once on mount. sessionStorage keeps it out of the URL (a prompt never
 * lands in browser history or server logs) and away from other tabs' sessions after the tab closes.
 */
export interface ReplayDraft {
  system?: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  lossy: boolean;
}
export interface ReplayHandoff extends ReplayDraft {
  requestId: string;
  model?: string;
}

const KEY = 'dirouter.replay';

function isTurn(turn: unknown): turn is ReplayDraft['history'][number] {
  if (turn === null || typeof turn !== 'object') return false;
  const { role, content } = turn as { role?: unknown; content?: unknown };
  return (role === 'user' || role === 'assistant') && typeof content === 'string' && content !== '';
}

export function storeReplay(handoff: ReplayHandoff): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(handoff));
  } catch {
    // Storage disabled: the playground simply opens empty.
  }
}

/** The pending replay, removed as it is read so a reload does not bring it back. */
export function takeReplay(): ReplayHandoff | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw) as Partial<ReplayHandoff>;
    if (typeof value.prompt !== 'string' || typeof value.requestId !== 'string') return undefined;
    return {
      requestId: value.requestId,
      prompt: value.prompt,
      history: Array.isArray(value.history) ? (value.history as unknown[]).filter(isTurn) : [],
      lossy: value.lossy === true,
      ...(typeof value.system === 'string' ? { system: value.system } : {}),
      ...(typeof value.maxTokens === 'number' ? { maxTokens: value.maxTokens } : {}),
      ...(typeof value.temperature === 'number' ? { temperature: value.temperature } : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
    };
  } catch {
    return undefined;
  }
}
