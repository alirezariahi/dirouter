export const samlFa = {
  protocol: 'پروتکل',
  idpEntityId: 'شناسهٔ IdP (Entity ID)',
  spEntityId: 'شناسهٔ DiRouter نزد IdP (SP Entity ID)',
  ssoUrl: 'آدرس ورود IdP (Single Sign-On URL)',
  cert: 'گواهی امضای IdP (PEM)',
  metadata: 'metadata',
  scimTitle: 'توکن‌های SCIM',
  scimHelp:
    'سرویس هویت (IdP) با این توکن کاربران و گروه‌ها را همگام می‌کند. آدرس SCIM: {{url}}. کاربر غیرفعال‌شده عضویتش حذف و کلیدهایش باطل می‌شود.',
  tokenName: 'نام توکن',
  create: 'ساخت توکن',
  revoke: 'ابطال',
  revoked: 'باطل‌شده',
  lastUsed: 'آخرین استفاده: {{date}}',
  never: 'هنوز استفاده نشده',
  shownOnce: 'این توکن فقط همین یک بار نمایش داده می‌شود:',
} as const;

export const samlEn = {
  protocol: 'Protocol',
  idpEntityId: 'IdP entity ID',
  spEntityId: "DiRouter's entity ID at the IdP (SP entity ID)",
  ssoUrl: 'IdP single sign-on URL',
  cert: 'IdP signing certificate (PEM)',
  metadata: 'metadata',
  scimTitle: 'SCIM tokens',
  scimHelp:
    'Your identity provider syncs users and groups with this token. SCIM URL: {{url}}. A deactivated user loses their membership and their keys are revoked.',
  tokenName: 'Token name',
  create: 'Create token',
  revoke: 'Revoke',
  revoked: 'Revoked',
  lastUsed: 'Last used {{date}}',
  never: 'Never used',
  shownOnce: 'This token is shown only this once:',
};
