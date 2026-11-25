/** The routing decision of one request in the log details (cards 32.5 and 32.7). */
import { useTranslation } from 'react-i18next';

import { type DataPolicyView, dataPolicyText, reasonText } from '../lib/route-decision';

export interface RouteDecisionData {
  dataPolicy?: DataPolicyView;
  skipped?: { modelId: string; credentialId?: string; reason: string }[];
}

export function RouteDecisionView({ decision }: { decision: unknown }) {
  const { t } = useTranslation();
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as RouteDecisionData;
  const skipped = Array.isArray(d.skipped) ? d.skipped : [];
  return (
    <section data-testid="log-route-decision" className="mt-4">
      <h3 className="font-semibold">{t('routingRequests.decision')}</h3>
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
