import type { MeContext, ModuleKey, Role } from '@jantrik/shared';
import {
  BookOpenCheckIcon,
  CalendarCheckIcon,
  LayersIcon,
  LayoutDashboardIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react';

export type NavKey = 'dashboard' | 'students' | 'sections' | 'attendance' | 'fees' | 'exams';

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Product module the page belongs to (CLAUDE.md rule 3). */
  module: ModuleKey;
  /** Roles that may open it; undefined = any member. */
  roles?: Role[];
}

const STAFF: Role[] = ['OWNER', 'ADMIN', 'TEACHER'];

/** Single source of truth for the sidebar and for page gates. Mirrors the API's guards. */
export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', href: '/dashboard', icon: LayoutDashboardIcon, module: 'CORE' },
  { key: 'students', href: '/students', icon: UsersIcon, module: 'CORE', roles: STAFF },
  {
    key: 'sections',
    href: '/sections',
    icon: LayersIcon,
    module: 'CORE',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    key: 'attendance',
    href: '/attendance',
    icon: CalendarCheckIcon,
    module: 'ATTENDANCE',
    roles: STAFF,
  },
  {
    key: 'fees',
    href: '/fees',
    icon: WalletIcon,
    module: 'FEES',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  },
  { key: 'exams', href: '/exams', icon: BookOpenCheckIcon, module: 'EXAMS', roles: STAFF },
];

export function canSee(item: NavItem, ctx: Pick<MeContext, 'modules' | 'roles'>): boolean {
  if (!ctx.modules.includes(item.module)) return false;
  return !item.roles || item.roles.some((r) => ctx.roles.includes(r));
}

export const navItem = (key: NavKey): NavItem => NAV_ITEMS.find((i) => i.key === key)!;
