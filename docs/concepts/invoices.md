[English](invoices.md) · [فارسی](invoices.fa.md)

# Invoices, VAT, the Persian PDF and the portal

Code: `packages/db/src/invoices.ts`, `packages/db/src/tax.ts`, `apps/control-api/src/billing/invoices.*` and `apps/control-api/src/billing/pdf/` · cards 19.6, 26.1 and 26.2

## What an invoice is

One invoice per organization per UTC month, issued after the month ends by the worker (`invoices-monthly`, daily at 02:30 UTC) or by the operator (`POST /orgs/{platform}/billing/invoices/generate?period=YYYY-MM`). Issuing the same month again changes nothing.

- **Prepaid** organizations (wallet): every figure comes from the wallet ledger. Opening balance, the month's movements by kind (top-up, gift, adjustment, refund, plan, usage), closing balance and usage by model.
- **Postpaid** organizations: the month's usage charges by model from the daily rollup; the closing amount is the amount due.

## VAT

Charges include VAT. The operator sets the rate in the billing settings (`PUT /orgs/{platform}/billing/settings`, field `tax.vatPercent`, for example `"10"`; the default `"0"` means no VAT). When an invoice is issued:

1. The **gross** is what the customer was charged for services in the month: usage and plan fees for prepaid organizations (top-ups, gifts and adjustments are not sales), the usage charges for postpaid ones.
2. It is split into **net + VAT** at the rate in force that day: `VAT = gross × rate / (100 + rate)`, rounded half up to 8 decimals. Net + VAT equals gross exactly.
3. The split is booked in the ledger in the same database transaction as the invoice, as a transaction of kind `invoice`:

| Basis    | Ledger legs                                                            |
| -------- | ---------------------------------------------------------------------- |
| prepaid  | `revenue` −VAT, `vat` +VAT (the customer's wallet is not touched)      |
| postpaid | `receivable` −gross, `revenue` +net, `vat` +VAT (the sale and its VAT) |

`vat` (VAT payable) and `receivable` (postpaid amounts invoiced and not yet settled) are system accounts. The invoice stores `vatPercent`, `grossUsd`, `netUsd`, `vatUsd` and `ledgerTransactionId`. The ledger check (`GET /orgs/{platform}/billing/invoices/{id}/verify`) recomputes the gross from the ledger, the split from the stored rate and compares the booked legs. The profit report shows `vatCollectedUsd` and `receivableUsd` beside the other ledger totals.

Invoices issued before card 26.1 have `vatPercent: null`: no VAT was split off and nothing is checked for them.

## Rials and the recorded rate

The rial rate is `exchangeRates.IRR` in the billing settings (rials per USD). The rate in force when the invoice is issued is stored on it (`exchangeRateIrr`) and never changes afterwards. The PDF shows every amount in USD and in whole rials (rounded half up; net in rials = gross in rials − VAT in rials, so the rial figures add up too), the rate itself and the total in tomans. Without a rate the PDF shows USD only and says so.

## Legal details of the seller and the buyer

Each organization keeps the details printed on its invoices:

| Endpoint                            | Permission      |
| ----------------------------------- | --------------- |
| `GET /orgs/{orgId}/billing-profile` | `billing:read`  |
| `PUT /orgs/{orgId}/billing-profile` | `billing:write` |

Fields: `partyType` (`legal` company or `natural` person), `legalName`, `nationalId` (11-digit national ID of a company, 10-digit national code of a person), `economicCode` (10 to 14 digits), `registrationNumber`, `address`, `postalCode` (10 digits) and `phone`. Persian digits are accepted and stored as ASCII digits. The platform organization's profile is the **seller**, a customer's is the **buyer**; without a profile the organization's name is used. Both are copied onto the invoice when it is issued, so a later change does not alter an issued invoice.

Connection to the tax authority's system (سامانهٔ مودیان) is not part of this; the invoice only carries the fields and the layout.

## Numbering

Numbers are `INV-<year>-<6 digits>`, sequential per year with no gap. The application numbers under a transaction-level advisory lock; the database is the backstop: a trigger refuses any number that is not the next of its year, and another refuses every update or deletion of an issued invoice. A failed issue rolls back the invoice and its ledger posting together, so no number is used up.

## The PDF

`GET /orgs/{orgId}/invoices/{id}/pdf` (customer) and `GET /orgs/{platform}/billing/invoices/{id}/pdf` (operator). A4, right to left, in Persian:

- Font: Vazirmatn (SIL Open Font License 1.1, `apps/control-api/src/billing/pdf/fonts/OFL.txt`), embedded as a subset with a ToUnicode map, so text can be searched and copied.
- Shaping: letters are joined by fontkit's OpenType shaper (through pdfkit). Lines are ordered with the Unicode Bidirectional Algorithm (bidi-js) and drawn chunk by chunk, so Persian reads right to left while invoice numbers, model names and amounts stay left to right.
- Dates: the issue date in the Jalali calendar (Tehran time) and the period as its Jalali first and last day, with the Gregorian month.
- Sections: seller and buyer, items (usage by model and plan fees, net of VAT, in USD and rials), net total, VAT on its own row with its rate, total with VAT, the rate and the total in tomans, and for prepaid customers the wallet movements of the month.

The unit test (`invoice-pdf.unit.test.ts`) reads the PDF back as a viewer would: it maps every drawn glyph to text through the embedded ToUnicode map, checks the Persian lines read correctly right to left and numbers left to right, and compares the outlines of the drawn glyphs with the OpenType-shaped forms of the same word (and not the isolated letters).

## In the customer portal (card 26.2)

The portal (`apps/portal`) gives a customer its usage and invoices without asking support:

- **Usage** (`/app/usage`): cost, requests and input/output tokens for the last 7, 30 or 90 days, a bar chart of cost and of tokens per day, tables by model and by key, and the latest 50 requests with the cost of each. Data: `GET /orgs/{orgId}/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` (`billing:read`; `to` is exclusive, at most 93 days, default the last 30).
- **Invoices** (`/app/invoices`): the month so far (`GET /orgs/{orgId}/invoices/preview`), every issued invoice with net, VAT and total, a **Download PDF** button, and the legal details printed on the next invoices (`billing-profile` above).

The usage figures are the same rows as the customer's other billing pages, so they agree to the last unit:

| Basis    | Cost of a request                                                  | Tokens          |
| -------- | ------------------------------------------------------------------ | --------------- |
| prepaid  | its `usage` debit in the wallet (the statement's usage line)       | the request log |
| postpaid | its sale price in the request log (what the monthly invoice bills) | the request log |

A request paid entirely from a plan's allowance takes nothing from the wallet and is not listed. Days are UTC days, keyed by when the wallet was debited.

Isolation: every route sits behind `OrgGuard`, so only members of the organization reach it (others get 404), and every query is filtered by that organization and its wallet; a request log row is joined only when it belongs to the same organization. `usage.integration.test.ts` checks both, and that the totals and each day equal the wallet statement's usage lines and the change in balance.
