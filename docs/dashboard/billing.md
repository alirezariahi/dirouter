# Billing pages (operator)

> Code: `apps/dashboard/src/pages/billing/*.tsx`, shared pieces in `components/billing`, access rules and exact money helpers in `lib/billing.ts`, messages in `i18n/billing`. Cards 25.1 and 25.2.

The **Billing** entry in the sidebar is the operator's place for customers' money. Everything on it used to need `curl` against the billing API.

## Who sees it

- Only the **platform organization** (the one created by the first setup; `/auth/me` returns `isPlatform: true` for it).
- Only members whose effective permissions include **`billing:read`**. Owners and admins have it; a custom role can grant it.
- Changing anything (top-ups, settings, codes, revocation) needs **`billing:write`**. Without it every page is read-only and says so.

Everyone else does not get a menu entry, and opening `/billing` directly shows "Page not found", the same answer the API gives (404) for billing routes on any other organization. The API is the authority; the dashboard only hides what would fail.

## Customers and wallets — `/billing`

- Every customer organization with its account type (prepaid or postpaid) and wallet balance, the number of customers, the exact total of all balances and a search box. **Export CSV** saves the list.
- **Ledger** tile: the double-entry check (`GET billing/ledger/check`). "Balanced" means the books add up to zero, no transaction is unbalanced and no wallet's cached balance has drifted from its entries.
- **Wallet** opens the customer's wallet: balance, amount reserved by requests in flight, available amount, the prepaid switch and the statement (newest first with the balance after each movement, 100 at a time, **Older movements** for more, **Export CSV**).
- **Manual credit or debit**: choose _Add credit_ or _Debit_, the amount in USD (up to 8 decimals) and a reason (at least 3 characters), then confirm. The reason appears on the customer's statement. Every adjustment is written to the platform's **audit log** as `billing.wallet_adjusted` with the actor, amount, reason and transaction (see Security → Audit log).
- Each form submission carries an idempotency key. Retrying a submission that failed reuses the key, so a double click or a retry after a network error can never credit twice; a successful submission starts a new key for the next adjustment.
- A debit larger than the balance is refused (402, insufficient credit).

Amounts on these pages are shown rounded for reading; hover an amount to see the exact ledger figure.

## Payments — `/billing/payments`

- All online top-ups (Zarinpal and Stripe), filtered by status (all, pending, succeeded, failed, expired), with the customer, the credit in USD, the amount actually charged in the gateway's currency (rials for Zarinpal), the gateway reference and any failure reason. **Export CSV** saves the listed rows.
- **Reconcile with gateways** (`POST billing/payments/reconcile`) asks the gateways about payments pending for more than two minutes (a lost callback or webhook) and shows how many were checked and what they became. A successful payment credits the wallet exactly once, whichever path settles it.

## Gateways and rates — `/billing/settings`

- **Payment gateways**: switch Zarinpal and Stripe on or off. A gateway is offered to customers only when it is on here **and** its keys are configured in the control-api environment (`ZARINPAL_MERCHANT_ID`, `STRIPE_SECRET_KEY`); the status next to each one says which it is.
- **Exchange rates**: units of each currency per USD. Zarinpal charges in rials and needs an **IRR** rate; the page refuses to turn Zarinpal on without one.
- **Top-up limits** (smallest and largest online top-up in USD) and the **customer portal** (open sign-up, welcome credit).
- Settings are one record; a save applies at once, without a deploy.

## Gift codes — `/billing/gift-codes`

- **Create a batch**: name, type (gift or recharge), amount per code, number of codes (up to 10,000), uses per code, optional expiry date (end of that day, Tehran time).
- The codes are shown **once**, right after creation; the server stores only their hashes. Use **Download codes (CSV)** (one line per code with batch, type, amount, uses and expiry) or **Copy all** before leaving the page.
- **Batches**: amount, used / capacity, credit given, state (active, expired, revoked). **Redemptions** lists who redeemed which code and when. **Export CSV** saves the batch report.
- **Bulk revoke**: tick batches (or the header box for all active ones) and **Revoke selected**. Revoking is permanent: revoked codes are refused, credit already given stays. Each revocation is in the audit log (`billing.gift_batch_revoked`).

## Pricing — `/billing/pricing`

- **Model sale prices and marketplace**: every model of the platform organization with its purchase cost (input / output per million tokens). Set the **multiplier** (sale price = cost × multiplier), or a **fixed price per request** (images, video) which replaces the token price, and the **cache share** (what an answer served from DiRouter's cache costs, as a share of the normal price; 0 makes it free). **Marketplace** publishes the model to customer organizations; an unpublished platform model stays private. The sale price column previews cost × multiplier with the gateway's own rounding (8 decimals, half up). **Save** writes the row to the model (`PATCH models/:id`, which also needs `models:write`).
- A saved price **applies to the next request**: control-api rebuilds the config snapshot after the change and the gateway loads it within seconds, no deploy.
- **Customer groups**: a group's multiplier scales every price for its members (0.8 is 20% off). Create, change the multiplier or delete a group (members go back to list price).
- **Each customer's group**: pick the price group of every customer organization; it applies from that customer's next request.

## Plans and subscriptions — `/billing/plans`

- **Plans**: name, monthly fee and included credit. The fee is taken from the wallet when each period starts; the included credit pays for usage before the wallet does. Change the fee or credit inline, or switch a plan to **Hidden** so new customers cannot pick it (existing subscriptions stay).
- **Subscriptions** (`GET billing/subscriptions`, new in card 25.2): every customer's plan, status (active, ending at period end, past due, cancelled), current period, credit used / included and what is left.

## Invoices — `/billing/invoices`

- Every customer's monthly invoice, optionally for one month: number, customer, prepaid or postpaid, opening balance, usage, closing balance.
- **Verify** recomputes the stored invoice from the ledger and compares every figure; the result shows "Matches the ledger" or the figures that differ.
- **PDF** downloads the invoice document (`INV-<year>-<n>.pdf`).
- **Issue a month's invoices** runs the monthly job for a finished month (the worker also runs it on schedule). It is idempotent: an issued invoice never changes and a second run creates nothing.

## Profit report — `/billing/profit`

- Purchase cost against revenue by model for a range of whole days (UTC; _Until_ is inclusive), optionally for **one customer** and/or **one model**. The model list offers the models sold in the range.
- Every figure on the page — the revenue, cost and profit tiles, each row and the ledger figures — is the `GET billing/reports/profit` answer shown as sent; the browser does not re-add rows, so the page always equals the endpoint. Hover an amount (or read the small line under each total) for the exact 8-decimal figure. The margin tile is profit ÷ revenue of the shown totals.
- **Ledger in the same range** (revenue booked, funds received, promotional credit, written off) are the platform's system accounts and are not narrowed by the customer or model filter.
- **Export CSV** saves the rows and a total line with the endpoint's exact strings.
- The platform organization's own traffic is not a sale and is never included.

## API used

All paths are under `/api/v1/orgs/:orgId/` where `:orgId` is the platform organization.

| Page                    | Calls                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customers and wallets   | `GET billing/wallets`, `GET billing/wallets/:id`, `GET billing/wallets/:id/statement`, `PATCH billing/wallets/:id`, `POST billing/wallets/:id/adjustments`, `GET billing/ledger/check` |
| Payments                | `GET billing/payments?status=`, `POST billing/payments/reconcile`                                                                                                                      |
| Gateways and rates      | `GET billing/settings`, `PUT billing/settings`                                                                                                                                         |
| Gift codes              | `GET/POST billing/gift-batches`, `GET billing/gift-batches/:id/redemptions`, `POST billing/gift-batches/:id/revoke`                                                                    |
| Pricing                 | `GET models`, `PATCH models/:id` (`isPublic`, `sale`), `GET/POST billing/groups`, `PATCH/DELETE billing/groups/:id`, `PUT billing/wallets/:id/group`                                   |
| Plans and subscriptions | `GET/POST billing/plans`, `PATCH billing/plans/:id`, `GET billing/subscriptions`                                                                                                       |
| Invoices                | `GET billing/invoices?period=`, `GET billing/invoices/:id/verify`, `GET billing/invoices/:id/pdf`, `POST billing/invoices/generate?period=`                                            |
| Profit report           | `GET billing/reports/profit?from=&to=&organizationId=&model=`                                                                                                                          |

Customer-side routes (`/orgs/:orgId/wallet/*`: own wallet, top-up checkout, redeem, subscribe) belong to the customer portal, not to these operator pages.
