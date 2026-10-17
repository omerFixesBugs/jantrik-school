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

/** Sidebar groups, in display order. */
export type NavGroup = 'overview' | 'academic' | 'accounts';
export const NAV_GROUPS: NavGroup[] = ['overview', 'academic', 'accounts'];

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Product module the page belongs to (CLAUDE.md rule 3). */
  module: ModuleKey;
  /** Roles that may open it; undefined = any member. */
  roles?: Role[];
}

const STAFF: Role[] = ['OWNER', 'ADMIN', 'TEACHER'];

/** Roles that work in the institute (everyone except guardians and students). */
export const STAFF_ROLES: Role[] = ['OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF'];

export const isStaff = (roles: Role[]): boolean => roles.some((r) => STAFF_ROLES.includes(r));

/** The role to show under a person's name: the most senior one they hold. */
export function primaryRole(roles: Role[]): Role | null {
  const order: Role[] = [...STAFF_ROLES, 'GUARDIAN', 'STUDENT'];
  return order.find((r) => roles.includes(r)) ?? null;
}

/** Single source of truth for the sidebar and for page gates. Mirrors the API's guards. */
export const NAV_ITEMS: NavItem[] = [
  {
    key: 'dashboard',
    href: '/dashboard',
    icon: LayoutDashboardIcon,
    group: 'overview',
    module: 'CORE',
  },
  {
    key: 'students',
    href: '/students',
    icon: UsersIcon,
    group: 'academic',
    module: 'CORE',
    roles: STAFF,
  },
  {
    key: 'sections',
    href: '/sections',
    icon: LayersIcon,
    group: 'academic',
    module: 'CORE',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    key: 'attendance',
    href: '/attendance',
    icon: CalendarCheckIcon,
    group: 'academic',
    module: 'ATTENDANCE',
    roles: STAFF,
  },
  {
    key: 'fees',
    href: '/fees',
    icon: WalletIcon,
    group: 'accounts',
    module: 'FEES',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  },
  {
    key: 'exams',
    href: '/exams',
    icon: BookOpenCheckIcon,
    group: 'academic',
    module: 'EXAMS',
    roles: STAFF,
  },
];

export function canSee(item: NavItem, ctx: Pick<MeContext, 'modules' | 'roles'>): boolean {
  if (!ctx.modules.includes(item.module)) return false;
  return !item.roles || item.roles.some((r) => ctx.roles.includes(r));
}

export const navItem = (key: NavKey): NavItem => NAV_ITEMS.find((i) => i.key === key)!;

/** The nav item a path belongs to (for the top bar title and breadcrumb). */
export const navItemForPath = (pathname: string): NavItem | undefined =>
  NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
