---
'@dirouter/control-api': minor
'@dirouter/db': minor
'@dirouter/worker': minor
'@dirouter/dashboard': minor
---

Invoices are now Persian PDFs that can be given to an Iranian customer: right to left with joined
letters, Vazirmatn embedded as a subset, Jalali dates, amounts in USD and rials at the rate recorded
when the invoice was issued (and the total in tomans), the seller's and buyer's legal details
(`GET`/`PUT /orgs/{orgId}/billing-profile`) and VAT on its own row. Set the rate with
`tax.vatPercent` in the billing settings (default `0`): charges include VAT, and issuing an invoice
splits the month's charges into net + VAT and books the VAT in the ledger (new system accounts
`vat` and `receivable`; postpaid sales are now booked when invoiced). Invoice numbers stay gap-free
and the database now refuses a skipped number and any edit or deletion of an issued invoice. Run the
`invoice_tax_fields` migration; invoices issued before it keep no VAT.
