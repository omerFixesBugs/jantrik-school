import { describe, expect, it } from 'vitest';
import {
  noticeInputSchema,
  noticeState,
  noticeVisibleTo,
  publishNoticeSchema,
  withdrawNoticeSchema,
  type NoticeVisibilityFields,
  type NoticeViewer,
} from './index.js';

const NOW = new Date('2026-11-17T06:00:00Z');
const C6 = '00000000-0000-4000-8000-000000000006';
const C7 = '00000000-0000-4000-8000-000000000007';
const S6A = '00000000-0000-4000-8000-00000000006a';
const S6B = '00000000-0000-4000-8000-00000000006b';

const notice = (over: Partial<NoticeVisibilityFields> = {}): NoticeVisibilityFields => ({
  status: 'PUBLISHED',
  audience: 'ALL',
  publishAt: '2026-11-17T05:00:00Z',
  expiresAt: null,
  targets: [],
  ...over,
});
const staff: NoticeViewer = { staff: true, guardian: false, children: [] };
const guardianOf = (...children: NoticeViewer['children']): NoticeViewer => ({
  staff: false,
  guardian: true,
  children,
});
const in6a = guardianOf({ classLevelId: C6, sectionId: S6A });
const in7 = guardianOf({ classLevelId: C7, sectionId: null });

describe('noticeVisibleTo (review focus 5)', () => {
  it('only a live notice: published, its time come, not expired', () => {
    expect(noticeVisibleTo(notice(), staff, NOW)).toBe(true);
    expect(noticeVisibleTo(notice({ status: 'DRAFT' }), staff, NOW)).toBe(false);
    expect(noticeVisibleTo(notice({ status: 'WITHDRAWN' }), staff, NOW)).toBe(false);
    expect(noticeVisibleTo(notice({ publishAt: '2026-11-17T06:00:01Z' }), staff, NOW)).toBe(false);
    expect(noticeVisibleTo(notice({ publishAt: NOW }), staff, NOW)).toBe(true);
    expect(noticeVisibleTo(notice({ expiresAt: NOW }), staff, NOW)).toBe(false);
    expect(noticeVisibleTo(notice({ publishAt: null }), staff, NOW)).toBe(false);
  });

  it('staff see ALL and STAFF notices whatever the targets; never GUARDIANS ones', () => {
    const targeted = { targets: [{ classLevelId: C7, sectionId: null }] };
    expect(noticeVisibleTo(notice({ audience: 'STAFF', ...targeted }), staff, NOW)).toBe(true);
    expect(noticeVisibleTo(notice({ audience: 'ALL', ...targeted }), staff, NOW)).toBe(true);
    expect(noticeVisibleTo(notice({ audience: 'GUARDIANS' }), staff, NOW)).toBe(false);
  });

  it('a guardian sees untargeted ALL/GUARDIANS notices, never STAFF ones', () => {
    expect(noticeVisibleTo(notice(), in6a, NOW)).toBe(true);
    expect(noticeVisibleTo(notice({ audience: 'GUARDIANS' }), in6a, NOW)).toBe(true);
    expect(noticeVisibleTo(notice({ audience: 'STAFF' }), in6a, NOW)).toBe(false);
  });

  it('targets: by class, or by class and section', () => {
    const forClass6 = notice({ targets: [{ classLevelId: C6, sectionId: null }] });
    expect(noticeVisibleTo(forClass6, in6a, NOW)).toBe(true);
    expect(noticeVisibleTo(forClass6, in7, NOW)).toBe(false);
    const for6b = notice({ targets: [{ classLevelId: C6, sectionId: S6B }] });
    expect(noticeVisibleTo(for6b, in6a, NOW)).toBe(false);
    // A child with no section yet matches only a whole-class target.
    const noSection = guardianOf({ classLevelId: C6, sectionId: null });
    expect(noticeVisibleTo(for6b, noSection, NOW)).toBe(false);
    expect(noticeVisibleTo(forClass6, noSection, NOW)).toBe(true);
    // Children in both classes: a notice for either.
    const both = guardianOf({ classLevelId: C6, sectionId: S6A }, { classLevelId: C7, sectionId: null });
    expect(noticeVisibleTo(notice({ targets: [{ classLevelId: C7, sectionId: null }] }), both, NOW)).toBe(true);
    // A guardian with no current child sees no targeted notice.
    expect(noticeVisibleTo(forClass6, guardianOf(), NOW)).toBe(false);
  });

  it('both roles: the union', () => {
    const teacherParent: NoticeViewer = { ...in7, staff: true };
    expect(noticeVisibleTo(notice({ audience: 'STAFF' }), teacherParent, NOW)).toBe(true);
    expect(
      noticeVisibleTo(
        notice({ audience: 'GUARDIANS', targets: [{ classLevelId: C7, sectionId: null }] }),
        teacherParent,
        NOW,
      ),
    ).toBe(true);
    expect(
      noticeVisibleTo(
        notice({ audience: 'GUARDIANS', targets: [{ classLevelId: C6, sectionId: null }] }),
        teacherParent,
        NOW,
      ),
    ).toBe(false);
  });
});

describe('noticeState', () => {
  it('draft, scheduled, published, expired, withdrawn', () => {
    expect(noticeState(notice({ status: 'DRAFT', publishAt: null }), NOW)).toBe('DRAFT');
    expect(noticeState(notice({ publishAt: '2026-11-18T00:00:00Z' }), NOW)).toBe('SCHEDULED');
    expect(noticeState(notice(), NOW)).toBe('PUBLISHED');
    expect(noticeState(notice({ expiresAt: '2026-11-17T05:30:00Z' }), NOW)).toBe('EXPIRED');
    expect(noticeState(notice({ status: 'WITHDRAWN' }), NOW)).toBe('WITHDRAWN');
  });
});

describe('notice schemas', () => {
  it('trims, normalises line endings, and keeps the CHECK limits', () => {
    const ok = noticeInputSchema.parse({ title: '  ছুটি  ', body: 'a\r\nb', audience: 'ALL' });
    expect(ok).toMatchObject({ title: 'ছুটি', body: 'a\nb', targets: [], pinned: false, expiresAt: null });
    expect(noticeInputSchema.safeParse({ title: 'x'.repeat(151), body: 'b', audience: 'ALL' }).success).toBe(false);
    expect(noticeInputSchema.safeParse({ title: '   ', body: 'b', audience: 'ALL' }).success).toBe(false);
    expect(noticeInputSchema.safeParse({ title: 't', body: 'x'.repeat(5001), audience: 'ALL' }).success).toBe(false);
    expect(noticeInputSchema.safeParse({ title: 't', body: 'b', audience: 'PARENTS' }).success).toBe(false);
    expect(
      noticeInputSchema.parse({
        title: 't',
        body: 'b',
        audience: 'GUARDIANS',
        targets: [{ classLevelId: C6 }],
        expiresAt: '2026-11-20T00:00:00+06:00',
      }),
    ).toMatchObject({ targets: [{ classLevelId: C6, sectionId: null }], expiresAt: new Date('2026-11-19T18:00:00Z') });
  });

  it('publish later needs an offset time; a withdrawal needs a reason of at most 300', () => {
    expect(publishNoticeSchema.parse({})).toEqual({ publishAt: null });
    expect(publishNoticeSchema.safeParse({ publishAt: '2026-11-20 10:00' }).success).toBe(false);
    expect(withdrawNoticeSchema.safeParse({ reason: ' ' }).success).toBe(false);
    expect(withdrawNoticeSchema.safeParse({ reason: 'x'.repeat(301) }).success).toBe(false);
    expect(withdrawNoticeSchema.parse({ reason: ' typo ' })).toEqual({ reason: 'typo' });
  });
});
