import { useTranslation } from 'react-i18next';

import { Card } from '../components/ui/card';
import { Empty } from '../components/ui/states';
import type { NavKey } from '../components/layout/nav';

export function Placeholder({ page }: { page: NavKey }) {
  const { t } = useTranslation();
  return (
    <section className="enter flex flex-col gap-6">
      <h1 className="text-2xl leading-8 font-semibold">{t(`nav.${page}`)}</h1>
      <Card>
        <Empty>{t('state.soon')}</Empty>
      </Card>
    </section>
  );
}
