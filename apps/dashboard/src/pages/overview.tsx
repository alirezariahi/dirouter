import { useTranslation } from 'react-i18next';

import { Card } from '../components/ui/card';
import { formatDate } from '../lib/date';
import { useSettings } from '../settings';

export default function OverviewPage() {
  const { t } = useTranslation();
  const s = useSettings();
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{t('overview.title')}</h1>
      <Card>
        <p data-testid="today">
          {t('overview.today', {
            date: formatDate(new Date(), { calendar: s.calendar, lang: s.lang }),
          })}
        </p>
        <p className="mt-2 text-sm text-muted">{t('state.soon')}</p>
      </Card>
    </section>
  );
}
