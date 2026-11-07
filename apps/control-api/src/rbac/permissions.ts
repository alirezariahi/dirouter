/**
 * ماتریس دسترسی نقش‌ها در سطح سازمان (کارت ۳.۵). منبع واحد برای Guard، تست و docs/rbac.md.
 * مجوزهای کارت‌های بعدی (provider، کلید، مدل، مصرف) هم این‌جا تعریف شده‌اند تا ماتریس کامل باشد.
 */
export const PERMISSIONS = [
  'org:read',
  'org:write',
  'members:read',
  'members:write',
  'invites:write',
  'teams:read',
  'teams:write',
  'projects:read',
  'projects:write',
  'providers:read',
  'providers:write',
  'keys:read',
  'keys:write',
  'models:read',
  'models:write',
  'usage:read',
  'audit:read',
  /** ریست دستی breaker و cooldown در صفحهٔ Health (کارت ۷.۸)؛ فقط OWNER و ADMIN. */
  'health:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const READ = PERMISSIONS.filter((p) => p.endsWith(':read'));

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  // ادمین همه‌کار می‌کند جز آنچه فقط مالک می‌تواند (در سرویس: نقش OWNER را فقط OWNER می‌دهد یا می‌گیرد).
  ADMIN: new Set(PERMISSIONS),
  // عضو همه‌چیز را می‌بیند و کلید و پروژهٔ خودش را می‌سازد، ولی پیکربندی سازمان را نه.
  MEMBER: new Set<Permission>([...READ, 'projects:write', 'keys:write']),
  VIEWER: new Set<Permission>(READ),
};

/** credentialها و secretها هیچ‌وقت خوانده نمی‌شوند؛ provider:read فقط فراداده است. */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** ترتیب قدرت نقش‌ها برای «نمی‌توانی نقشی بالاتر از خودت بدهی». */
export const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
