/**
 * Stored payload of one request in the Log Explorer (card 24.1). Rendered only for members holding
 * `logs:bodies`; the API enforces the same permission. The replay button hands the conversation to
 * the playground, where any model can be picked.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { bodyMessages } from '../i18n/body-messages';
import { api, ApiError } from '../lib/api';
import { formatNumber } from '../lib/date';
import { type ReplayDraft, storeReplay } from '../lib/replay';
import { useSettings } from '../settings';
import { Button } from './ui/button';
import { ErrorState, Loading } from './ui/states';

export interface StoredBody {
  requestId: string;
  level: 'metadata' | 'full';
  metadata: {
    model?: string;
    stream?: boolean;
    parameters?: string[];
    messages?: number;
    roles?: Record<string, number>;
    tools?: string[];
    requestBytes?: number;
    responseBytes?: number;
    finishReason?: string;
  };
  request: string | null;
  requestTruncated: boolean;
  response: string | null;
  responseTruncated: boolean;
  streamed: boolean;
  redactions: number;
  replay: ReplayDraft | null;
}

/** JSON shown indented; a cut (truncated) body is not valid JSON and is shown as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function RequestPayload({ orgId, id }: { orgId: string; id: string }) {
  const s = useSettings();
  const m = bodyMessages[s.lang];
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['log-body', orgId, id],
    queryFn: () => api<StoredBody>(`/orgs/${orgId}/logs/${encodeURIComponent(id)}/body`),
    retry: false,
  });
  const n = (v: number | undefined) => formatNumber(v ?? 0, s.lang);
  if (query.isPending) return <Loading />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404)
      return <p className="text-sm text-muted">{m.noBody}</p>;
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const body = query.data;
  const meta = body.metadata;
  const replay = body.replay;
  const parts: [string, string | null, boolean][] = [
    [m.request, body.request, body.requestTruncated],
    [m.response, body.response, body.responseTruncated],
  ];
  return (
    <section aria-label={m.payload} data-testid="log-payload" className="flex flex-col gap-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-muted">{m.level}</dt>
          <dd>{m.levels[body.level]}</dd>
        </div>
        <div>
          <dt className="text-muted">{m.redactions}</dt>
          <dd>{n(body.redactions)}</dd>
        </div>
        <div>
          <dt className="text-muted">{m.bytes}</dt>
          <dd dir="ltr">
            {n(meta.requestBytes)} / {n(meta.responseBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-muted">{m.messages}</dt>
          <dd dir="ltr">
            {n(meta.messages)}
            {meta.roles
              ? ` (${Object.entries(meta.roles)
                  .map(([role, count]) => `${role}: ${String(count)}`)
                  .join(', ')})`
              : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted">{m.parameters}</dt>
          <dd dir="ltr">{meta.parameters?.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt className="text-muted">{m.tools}</dt>
          <dd dir="ltr">{meta.tools?.join(', ') || '—'}</dd>
        </div>
        {meta.finishReason ? (
          <div>
            <dt className="text-muted">{m.finish}</dt>
            <dd dir="ltr">{meta.finishReason}</dd>
          </div>
        ) : null}
      </dl>
      {body.level === 'full'
        ? parts.map(([label, text, truncated]) =>
            text === null ? null : (
              <div key={label} className="flex flex-col gap-1">
                <h4 className="font-medium">{label}</h4>
                {label === m.response && body.streamed ? (
                  <p className="text-xs text-muted">{m.streamed}</p>
                ) : null}
                <pre
                  dir="ltr"
                  className="max-h-96 overflow-auto rounded bg-border/30 p-3 text-xs whitespace-pre-wrap"
                >
                  {prettyJson(text)}
                </pre>
                {truncated ? <p className="text-xs text-warn">{m.truncated}</p> : null}
              </div>
            ),
          )
        : null}
      {body.level === 'full' ? (
        replay ? (
          <div className="flex flex-col gap-1">
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  storeReplay({
                    ...replay,
                    requestId: body.requestId,
                    ...(meta.model ? { model: meta.model } : {}),
                  });
                  void navigate({ to: '/playground' });
                }}
              >
                {m.replay}
              </Button>
            </div>
            {replay.lossy ? <p className="text-xs text-muted">{m.replayLossy}</p> : null}
          </div>
        ) : (
          <p className="text-xs text-muted">{m.noReplay}</p>
        )
      ) : null}
    </section>
  );
}
