[English](release.md) · [فارسی](release.fa.md)

# انتشار نسخه

DiRouter از [نسخه‌گذاری معنایی](https://semver.org) پیروی می‌کند و همهٔ بسته‌هایش را با هم و به کمک [Changesets](https://github.com/changesets/changesets) نسخه‌گذاری می‌کند (`.changeset/config.json`).

1. همراه هر تغییری که کاربر می‌بیند یک changeset اضافه کنید: `pnpm changeset` (نوع افزایش نسخه را انتخاب کنید؛ همهٔ بسته‌ها به یک نسخه می‌روند).
2. برای انتشار، `pnpm changeset version` را اجرا کنید. changesetهای معلق را اعمال می‌کند، نسخهٔ همهٔ بسته‌ها را بالا می‌برد و `CHANGELOG.md` هر کدام را می‌نویسد. خلاصهٔ نسخه را در `CHANGELOG.md` ریشه بنویسید.
3. commit کنید، منتظر CI سبز روی `main` بمانید، سپس commit را با `v<version>` تگ بزنید و تگ را push کنید.
4. اجرای CI برای تگ همه‌چیز را بررسی می‌کند، سپس هر ایمیج را می‌سازد، اسکن می‌کند، با cosign امضا می‌کند و همراه attestation SBOM به نام `ghcr.io/alirezariahi/dirouter/<app>:<version>` منتشر می‌کند. تگی که روی `main` نباشد یا semver معتبر نباشد رد می‌شود.
5. وقتی نسخه‌ای به اقدامی از طرف اپراتور نیاز دارد، یادداشت ارتقا بنویسید (مثل [upgrade-v1.fa.md](upgrade-v1.fa.md) و [upgrade-v1.1.fa.md](upgrade-v1.1.fa.md)).
