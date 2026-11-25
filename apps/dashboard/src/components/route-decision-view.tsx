/** The routing decision of one request in the log details (cards 32.5 and 32.7). */
import { useTranslation } from 'react-i18next';

import { type DataPolicyView, dataPolicyText, reasonText } from '../lib/route-decision';

export interface RouteDecisionData {
  dataPolicy?: DataPolicyView;
  suffixes?: string[];
  /** Card 32.7. */
  models?: string[];
  rule?: { id: string; name?: string };
  candidates?: { modelId: string; providerId: string; estimatedCostUsd: string }[];
  estimatedCostUsd?: string;
  skipped?: { modelId: string; credentialId?: string; reason: string }[];
}

export function RouteDecisionView({
  decision,
  serviceTier,
}: {
  decision: unknown;
  /** The tier the request was priced at (card 31.5). */
  serviceTier?: string | null | undefined;
}) {
  const { t } = useTranslation();
  if ((!decision || typeof decision !== 'object') && !serviceTier) return null;
  const d = (decision && typeof decision === 'object' ? decision : {}) as RouteDecisionData;
  const skipped = Array.isArray(d.skipped) ? d.skipped : [];
  return (
    <section data-testid="log-route-decision" className="mt-4">
      <h3 className="font-semibold">{t('routingRequests.decision')}</h3>
      {serviceTier ? (
        <p className="text-sm">
          <span className="text-muted">{t('routingRequests.serviceTier')}:</span>{' '}
          <span dir="ltr">{serviceTier}</span>
        </p>
      ) : null}
      {d.suffixes?.length ? (
        <p className="text-sm">
          <span className="text-muted">{t('routingRequests.suffixes')}:</span>{' '}
          <span dir="ltr">{d.suffixes.map((s) => `:${s}`).join(' ')}</span>
        </p>
      ) : null}
      {d.rule ? (
        <p className="text-sm">
          <span className="text-muted">{t('routingRequests.rule')}:</span>{' '}
          <span dir="ltr">{d.rule.name ?? d.rule.id}</span>
        </p>
      ) : null}
      {d.models?.length ? (
        <p className="text-sm">
          <span className="text-muted">{t('routingRequests.modelChain')}:</span>{' '}
          <span dir="ltr">{d.models.join(' → ')}</span>
        </p>
      ) : null}
      {d.estimatedCostUsd ? (
        <p className="text-sm">
          <span className="text-muted">{t('routingRequests.estimatedCost')}:</span>{' '}
          <span dir="ltr">${d.estimatedCostUsd}</span>
        </p>
      ) : null}
      {d.candidates?.length ? (
        <>
          <h4 className="mt-2 text-sm text-muted">{t('routingRequests.candidatesTitle')}</h4>
          <ol className="text-sm" data-testid="log-route-candidates">
            {d.candidates.map((c, index) => (
              <li key={`${c.modelId}:${String(index)}`} dir="ltr">
                {c.modelId} @ {c.providerId} · ${c.estimatedCostUsd}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {d.dataPolicy ? (
        <p className="text-sm">
          <span className="text-muted">{t('routingRequests.dataPolicy')}:</span>{' '}
          {dataPolicyText(t, d.dataPolicy)}
        </p>
      ) : null}
      {skipped.length > 0 ? (
        <>
          <h4 className="mt-2 text-sm text-muted">{t('routingRequests.removed')}</h4>
          <ul className="text-sm">
            {skipped.map((s, index) => (
              <li key={`${s.modelId}:${s.credentialId ?? ''}:${String(index)}`}>
                <span dir="ltr">{s.modelId}</span> — {reasonText(t, s.reason)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
