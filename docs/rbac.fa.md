[English](rbac.md) · [فارسی](rbac.fa.md)

<div dir="rtl">

# دسترسی‌ها (RBAC)

کد: `apps/control-api/src/rbac` و `apps/control-api/src/orgs` · تست: `orgs.integration.test.ts` · کارت ۳.۵

## نقش‌ها و مجوزها

نقش‌ها در سطح **سازمان** هستند (جدول `memberships`): OWNER، ADMIN، MEMBER و VIEWER. این ماتریس از `permissions.ts` ساخته شده است:

| مجوز              | OWNER | ADMIN | MEMBER | VIEWER |
| ----------------- | ----- | ----- | ------ | ------ |
| `org:read`        | ✅    | ✅    | ✅     | ✅     |
| `org:write`       | ✅    | ✅    | —      | —      |
| `members:read`    | ✅    | ✅    | ✅     | ✅     |
| `members:write`   | ✅    | ✅    | —      | —      |
| `invites:write`   | ✅    | ✅    | —      | —      |
| `teams:read`      | ✅    | ✅    | ✅     | ✅     |
| `teams:write`     | ✅    | ✅    | —      | —      |
| `projects:read`   | ✅    | ✅    | ✅     | ✅     |
| `projects:write`  | ✅    | ✅    | ✅     | —      |
| `providers:read`  | ✅    | ✅    | ✅     | ✅     |
| `providers:write` | ✅    | ✅    | —      | —      |
| `keys:read`       | ✅    | ✅    | ✅     | ✅     |
| `keys:write`      | ✅    | ✅    | ✅     | —      |
| `models:read`     | ✅    | ✅    | ✅     | ✅     |
| `models:write`    | ✅    | ✅    | —      | —      |
| `usage:read`      | ✅    | ✅    | ✅     | ✅     |
| `audit:read`      | ✅    | ✅    | ✅     | ✅     |

قانون‌های اضافه در سرویس، جدا از ماتریس:

- هیچ‌کس نقشی **بالاتر از نقش خودش** نمی‌دهد یا با آن دعوت نمی‌کند.
- فقط OWNER نقش OWNER را می‌دهد، می‌گیرد یا عضو OWNER را حذف می‌کند.
- **آخرین OWNER** سازمان قابل تنزل یا حذف نیست (409 `conflict`).
- مجوزهای `providers`، `keys`، `models`، `usage` و `audit` برای کارت‌های ۳.۶ تا ۳.۱۰ از قبل تعریف شده‌اند. `providers:read` هرگز secret را برنمی‌گرداند.

## چطور اعمال می‌شود

- همهٔ مسیرهای سازمانی زیر `/api/v1/orgs/:orgId/…` هستند و پشت `AccessGuard` (JWT) و `OrgGuard` قرار دارند.
- `OrgGuard` عضویت کاربر در `:orgId` را از DB می‌خواند. **عضو نبودن یعنی 404**، نه 403، تا وجود سازمان دیگر لو نرود.
- هر handler با `@RequirePermission('teams:write')` مجوزش را اعلام می‌کند. **مسیری که مجوز اعلام نکرده بسته است** (fail closed).
- **ایزولاسیون داده**: همهٔ کوئری‌ها با `organizationId` همان سازمانِ تأییدشده محدود می‌شوند. شناسهٔ یک تیم یا پروژه از سازمان دیگر، از مسیر سازمان خودت 404 می‌دهد.

## endpointها

| مسیر                                                                                 | مجوز                              |
| ------------------------------------------------------------------------------------ | --------------------------------- |
| `GET /orgs/:orgId`، `PATCH /orgs/:orgId`                                             | `org:read`، `org:write`           |
| `GET /members`، `PATCH /members/:userId` (`{role}`)، `DELETE /members/:userId`       | `members:read`، `members:write`   |
| `GET /invitations`، `POST /invitations` (`{email, role}`)، `DELETE /invitations/:id` | `members:read`، `invites:write`   |
| `GET/POST /teams`، `PATCH/DELETE /teams/:id`                                         | `teams:read`، `teams:write`       |
| `GET/POST /projects`، `PATCH/DELETE /projects/:id`                                   | `projects:read`، `projects:write` |
| `POST /auth/invitations/accept` (`{token, name?, password}`)                         | عمومی، با توکن دعوت               |

## دعوت

- `POST /invitations` لینک `PUBLIC_DASHBOARD_URL/invite/<token>` را برمی‌گرداند. توکن فقط **همین یک بار** نشان داده می‌شود و در DB فقط hash آن ذخیره است.
- عمر لینک ۷ روز است و یک بار مصرف می‌شود (UPDATE شرطی روی `accepted_at IS NULL`). لینک لغوشده یا منقضی 404 می‌دهد.
- اگر ایمیل دعوت قبلاً حساب داشته باشد، **رمز همان حساب لازم است**، پس داشتن لینک برای تصاحب حساب کسی کافی نیست. در غیر این صورت کاربر تازه با نام و رمز (حداقل ۱۰ کاراکتر) ساخته می‌شود.

## حذف و ممیزی

- حذف تیم و پروژه soft-delete است (`deleted_at`، و slug آزاد می‌شود). پروژه‌های تیم حذف‌شده بدون تیم می‌مانند.
- هر تغییر در `audit_logs` همان سازمان ثبت می‌شود: `team.*`، `project.*`، `member.*`، `invitation.*` و `org.updated`.

## تست

`apps/control-api/src/orgs/orgs.integration.test.ts` روی Postgres و Valkey واقعی، از راه HTTP، در job integration در CI اجرا می‌شود:

1. VIEWER همهٔ مسیرهای خواندنی را 200 و همهٔ ۱۱ عملیات نوشتنی را 403 می‌گیرد.
2. مالک سازمان A برای همهٔ مسیرهای سازمان B پاسخ 404 می‌گیرد، حتی با شناسهٔ تیم B از مسیر A.
3. MEMBER پروژه می‌سازد ولی تیم و دعوت نه.
4. ADMIN نمی‌تواند OWNER بسازد یا OWNER را تغییر دهد، و آخرین OWNER قابل تنزل نیست.
5. لینک دعوت یک‌بارمصرف است، منقضی می‌شود و حساب موجود را بدون رمز نمی‌پذیرد.
6. audit هر سازمان جدا ثبت می‌شود.

</div>
