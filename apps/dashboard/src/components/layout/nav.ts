import {
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Building2,
  Cable,
  FlaskConical,
  HeartPulse,
  KeyRound,
  Landmark,
  LayoutDashboard,
  type LucideIcon,
  Radio,
  ScrollText,
  Server,
  Signpost,
  Settings2,
  Shield,
  ShieldCheck,
  Wallet,
  Waypoints,
} from 'lucide-react';

/** Sidebar order; `group` is what an operator is doing there. */
export const NAV = [
  { to: '/', key: 'overview', icon: LayoutDashboard, group: 'monitor' },
  { to: '/analytics', key: 'analytics', icon: BarChart3, group: 'monitor' },
  { to: '/live', key: 'live', icon: Radio, group: 'monitor' },
  { to: '/logs', key: 'logs', icon: ScrollText, group: 'monitor' },
  { to: '/health', key: 'health', icon: HeartPulse, group: 'monitor' },
  { to: '/cost', key: 'cost', icon: Wallet, group: 'monitor' },
  { to: '/providers', key: 'providers', icon: Server, group: 'routing' },
  { to: '/models', key: 'models', icon: Boxes, group: 'routing' },
  { to: '/keys', key: 'keys', icon: KeyRound, group: 'routing' },
  { to: '/routing-policies', key: 'routingPolicies', icon: Signpost, group: 'routing' },
  { to: '/simulator', key: 'simulator', icon: Waypoints, group: 'routing' },
  { to: '/playground', key: 'playground', icon: FlaskConical, group: 'routing' },
  { to: '/mcp', key: 'mcp', icon: Cable, group: 'routing' },
  { to: '/guardrails', key: 'guardrails', icon: ShieldCheck, group: 'govern' },
  { to: '/alerts', key: 'alerts', icon: Bell, group: 'govern' },
  { to: '/security', key: 'security', icon: Shield, group: 'govern' },
  { to: '/config', key: 'config', icon: Settings2, group: 'govern' },
  { to: '/organization', key: 'organization', icon: Building2, group: 'workspace' },
  { to: '/guides', key: 'guides', icon: BookOpen, group: 'workspace' },
  // Operator only: shown on the platform organization with billing:read (card 25.1).
  { to: '/billing', key: 'billing', icon: Landmark, group: 'workspace', billing: true },
] as const satisfies readonly {
  to: string;
  key: string;
  icon: LucideIcon;
  group: string;
  billing?: boolean;
}[];
export type NavKey = (typeof NAV)[number]['key'];

export const NAV_GROUPS = ['monitor', 'routing', 'govern', 'workspace'] as const;

/** The entries this member may open: billing pages only for the platform's billing readers. */
export function visibleNav(billingVisible: boolean) {
  return NAV.filter((n) => billingVisible || !('billing' in n));
}
