/**
 * The workspace's invoices (card 26.2): month to date, every issued invoice with its VAT and a PDF
 * download, and the legal details printed on the next ones (card 26.1).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';

import { api, download } from '../lib/api';
import { date, usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { orgId } from '../lib/session';
import { Button, Card, Field, Mono, Notice } from '../lib/ui';

export interface Invoice {
  id: string;
  number: string;
  period: string;
  basis: 'prepaid' | 'postpaid';
  closingUsd: string;
  grossUsd: string;
  netUsd: string;
  vatUsd: string;
  vatPercent: string | null;
  createdAt: string;
}
interface Preview {
  period: string;
  basis: 'prepaid' | 'postpaid';
  totals: Record<string, string>;
  closingUsd: string;
}
interface Profile {
  partyType?: 'legal' | 'natural';
  legalName?: string;
  nationalId?: string | null;
  economicCode?: string | null;
  address?: string | null;
  postalCode?: string | null;
}

const negate = (v: string | undefined) =>
  v === undefined ? '0' : v.startsWith('-') ? v.slice(1) : `-${v}`;

type TextField = 'legalName' | 'nationalId' | 'economicCode' | 'address' | 'postalCode';

function ProfileForm() {
  const org = orgId();
  const profile = useQuery({
    queryKey: ['billing-profile', org],
    queryFn: () => api<Profile>(`/orgs/${org}/billing-profile`),
  });
  // The fields start from the saved details, so the form appears once they have loaded.
  return profile.data ? <ProfileFields initial={profile.data} /> : null;
}

function ProfileFields({ initial }: { initial: Profile }) {
  const { t } = useI18n();
  const org = orgId();
  const client = useQueryClient();
  const [form, setForm] = useState<Profile>(initial);
  const save = useMutation({
    mutationFn: () => {
      const blank = (v: string | null | undefined) => (v ? v : null);
      return api<Profile>(`/orgs/${org}/billing-profile`, {
        method: 'PUT',
        body: {
          // A person's national code has 10 digits, a company's national ID 11 (Persian or Latin).
          partyType:
            (form.nationalId ?? '').replace(/[^0-9۰-۹]/g, '').length === 10 ? 'natural' : 'legal',
          legalName: form.legalName ?? '',
          nationalId: blank(form.nationalId),
          economicCode: blank(form.economicCode),
          address: blank(form.address),
          postalCode: blank(form.postalCode),
        },
      });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: ['billing-profile', org] }),
  });
  const field = (key: TextField, label: string, ltr = false) => (
    <Field
      label={label}
      value={form[key] ?? ''}
      onChange={(e) => {
        setForm({ ...form, [key]: e.target.value });
      }}
      {...(ltr ? { dir: 'ltr' } : {})}
      required={key === 'legalName'}
    />
  );
  return (
    <Card title={t.invoiceDetails}>
      <p className="mb-3 text-sm text-stone-600">{t.invoiceDetailsHint}</p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {field('legalName', t.legalName)}
        {field('nationalId', t.nationalId, true)}
        {field('economicCode', t.economicCode, true)}
        {field('postalCode', t.postalCode, true)}
        <div className="sm:col-span-2">{field('address', t.address)}</div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>
            {t.save}
          </Button>
          {save.isSuccess && <span className="text-sm text-teal-700">{t.saved}</span>}
        </div>
        {save.error && (
          <div className="sm:col-span-2">
            <Notice tone="error">{save.error.message}</Notice>
          </div>
        )}
      </form>
    </Card>
  );
}

export function InvoicesPage() {
  const { t, lang } = useI18n();
  const org = orgId();
  const invoices = useQuery({
    queryKey: ['invoices', org],
    queryFn: () => api<Invoice[]>(`/orgs/${org}/invoices`),
  });
  const preview = useQuery({
    queryKey: ['invoice-preview', org],
    queryFn: () => api<Preview>(`/orgs/${org}/invoices/preview`),
  });
  const pdf = useMutation({
    mutationFn: (i: Invoice) => download(`/orgs/${org}/invoices/${i.id}/pdf`, `${i.number}.pdf`),
  });
  const p = preview.data;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-stone-900">{t.invoices}</h1>
      {p && (
        <Card title={`${t.monthToDate} · ${p.period}`}>
          <p className="text-sm text-stone-600">
            {t.usage}:{' '}
            <Mono>{usd(p.basis === 'prepaid' ? negate(p.totals.usage) : p.closingUsd)}</Mono>
            {p.basis === 'prepaid' && (
              <>
                {' '}
                · {t.balance}: <Mono>{usd(p.closingUsd)}</Mono>
              </>
            )}
          </p>
        </Card>
      )}
      <Card title={t.invoices}>
        {invoices.isSuccess && invoices.data.length === 0 && <Notice>{t.noInvoices}</Notice>}
        {invoices.error && <Notice tone="error">{invoices.error.message}</Notice>}
        {(invoices.data?.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-stone-500">
                <tr className="border-b border-stone-200">
                  <th className="py-2 text-start font-medium">{t.invoice}</th>
                  <th className="py-2 text-start font-medium">{t.period}</th>
                  <th className="py-2 text-start font-medium">{t.net}</th>
                  <th className="py-2 text-start font-medium">{t.vat}</th>
                  <th className="py-2 text-start font-medium">{t.total}</th>
                  <th className="py-2 text-start font-medium">{t.date}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.data?.map((i) => (
                  <tr key={i.id} className="border-b border-stone-100 last:border-0">
                    <td className="py-2">
                      <Mono>{i.number}</Mono>
                    </td>
                    <td className="py-2">
                      <Mono>{i.period}</Mono>
                    </td>
                    <td className="py-2">
                      <Mono>{usd(i.netUsd)}</Mono>
                    </td>
                    <td className="py-2">
                      <Mono>{usd(i.vatUsd)}</Mono>
                      {i.vatPercent !== null && (
                        <span className="text-stone-500">
                          {' '}
                          ({Number(i.vatPercent).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US')}
                          %)
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-medium">
                      <Mono>{usd(i.grossUsd)}</Mono>
                    </td>
                    <td className="py-2 text-stone-600">{date(i.createdAt, lang)}</td>
                    <td className="py-2 text-end">
                      <Button
                        variant="quiet"
                        disabled={pdf.isPending}
                        onClick={() => {
                          pdf.mutate(i);
                        }}
                      >
                        {t.downloadPdf}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pdf.error && <Notice tone="error">{pdf.error.message}</Notice>}
      </Card>
      <ProfileForm />
    </div>
  );
}
