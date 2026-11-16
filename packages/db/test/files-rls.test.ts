import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient, type StoredFileKind } from '../src/index.js';
import { appClient, createStudent, createTenant } from './helpers.js';

// Sprint 1 P2 (docs/plans/sprint-1-p2-files.md): stored_files, stored_file_usage,
// institute_profiles and students.photo_file_id. Tenant isolation, the grants (no UPDATE of a
// file, no DELETE of usage or profile), the CHECKs that back the per-kind caps, and the composite
// foreign keys that keep a row from pointing at another institute's file.

type Mime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'text/plain';

function fileData(
  tenantId: string,
  kind: StoredFileKind,
  mime: Mime,
  size: number,
  over: Partial<{ sizeBytes: number; sha256: string; width: number; height: number }> = {},
) {
  const bytes = new Uint8Array(size);
  bytes.fill(7);
  return {
    tenantId,
    kind,
    mime,
    bytes,
    sizeBytes: over.sizeBytes ?? size,
    sha256: over.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
    width: over.width ?? 100,
    height: over.height ?? 120,
  };
}

describe('files and the institute profile (P2)', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let aFile: string;

  const putFile = (
    tenantId: string,
    kind: StoredFileKind = 'STUDENT_PHOTO',
    mime: Mime = 'image/jpeg',
    size = 1000,
  ) =>
    withTenant(app, tenantId, (tx) =>
      tx.storedFile.create({ data: fileData(tenantId, kind, mime, size), select: { id: true } }),
    ).then((f) => f.id);

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    aFile = await putFile(a);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  describe('stored_files', () => {
    it("another institute cannot read, delete or write A's files", async () => {
      await withTenant(app, b, async (tx) => {
        expect(await tx.storedFile.findMany({ select: { id: true } })).toEqual([]);
        expect((await tx.storedFile.deleteMany({ where: { id: aFile } })).count).toBe(0);
      });
      await expect(
        withTenant(app, b, (tx) =>
          tx.storedFile.create({
            data: fileData(a, 'LOGO', 'image/png', 10),
            select: { id: true },
          }),
        ),
      ).rejects.toThrow();
      const mine = await withTenant(app, a, (tx) =>
        tx.storedFile.findUniqueOrThrow({ where: { id: aFile }, select: { sizeBytes: true } }),
      );
      expect(mine.sizeBytes).toBe(1000);
    });

    it('a file never changes: the app has no UPDATE', async () => {
      await expect(
        withTenant(app, a, (tx) => tx.$executeRaw`UPDATE stored_files SET width = 5`),
      ).rejects.toThrow(/permission denied/);
    });

    it.each<[string, StoredFileKind, Mime, number, Parameters<typeof fileData>[4]]>([
      ['an unknown mime', 'DOCUMENT_ASSET', 'text/plain', 10, {}],
      ['a GIF', 'DOCUMENT_ASSET', 'image/gif', 10, {}],
      ['a PNG photo', 'STUDENT_PHOTO', 'image/png', 10, {}],
      ['a JPEG signature', 'SIGNATURE', 'image/jpeg', 10, {}],
      ['a JPEG logo', 'LOGO', 'image/jpeg', 10, {}],
      ['a photo over 200 KB', 'STUDENT_PHOTO', 'image/jpeg', 204_801, {}],
      ['an applicant photo over 200 KB', 'APPLICANT_PHOTO', 'image/jpeg', 204_801, {}],
      ['a logo over 100 KB', 'LOGO', 'image/png', 102_401, {}],
      ['a seal over 100 KB', 'SEAL', 'image/webp', 102_401, {}],
      ['a signature over 100 KB', 'SIGNATURE', 'image/png', 102_401, {}],
      ['a document asset over 256 KB', 'DOCUMENT_ASSET', 'image/png', 262_145, {}],
      ['a size that is not the bytes’ length', 'STUDENT_PHOTO', 'image/jpeg', 10, { sizeBytes: 9 }],
      ['a malformed sha256', 'STUDENT_PHOTO', 'image/jpeg', 10, { sha256: 'ABC' }],
      ['width 0', 'STUDENT_PHOTO', 'image/jpeg', 10, { width: 0 }],
      ['height over 4000', 'STUDENT_PHOTO', 'image/jpeg', 10, { height: 4001 }],
    ])('refuses %s', async (_name, kind, mime, size, over) => {
      await expect(
        withTenant(app, a, (tx) =>
          tx.storedFile.create({ data: fileData(a, kind, mime, size, over), select: { id: true } }),
        ),
      ).rejects.toThrow();
    });

    it.each<[StoredFileKind, Mime, number]>([
      ['STUDENT_PHOTO', 'image/jpeg', 204_800],
      ['APPLICANT_PHOTO', 'image/jpeg', 204_800],
      ['LOGO', 'image/png', 102_400],
      ['LOGO', 'image/webp', 102_400],
      ['SEAL', 'image/png', 102_400],
      ['SIGNATURE', 'image/png', 102_400],
      ['DOCUMENT_ASSET', 'image/jpeg', 262_144],
    ])('accepts a %s (%s) of exactly its cap', async (kind, mime, size) => {
      await expect(putFile(a, kind, mime, size)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('stored_file_usage', () => {
    it('isolated per institute, never deleted, never negative', async () => {
      await withTenant(app, a, (tx) =>
        tx.storedFileUsage.create({ data: { tenantId: a, bytesUsed: 1000, fileCount: 1 } }),
      );
      await withTenant(app, b, async (tx) => {
        expect(await tx.storedFileUsage.findMany()).toEqual([]);
        expect((await tx.storedFileUsage.updateMany({ data: { bytesUsed: 0 } })).count).toBe(0);
      });
      await expect(
        withTenant(app, b, (tx) => tx.storedFileUsage.create({ data: { tenantId: a } })),
      ).rejects.toThrow();
      await expect(
        withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM stored_file_usage`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(app, a, (tx) => tx.storedFileUsage.updateMany({ data: { bytesUsed: -1 } })),
      ).rejects.toThrow();
      await expect(
        withTenant(app, a, (tx) => tx.storedFileUsage.updateMany({ data: { fileCount: -1 } })),
      ).rejects.toThrow();
    });
  });

  describe('institute_profiles', () => {
    let c: string;

    beforeAll(async () => {
      c = (await createTenant(app)).id;
      await withTenant(app, a, (tx) =>
        tx.instituteProfile.create({ data: { tenantId: a, nameBn: 'শাপলা উচ্চ বিদ্যালয়' } }),
      );
    });

    it("another institute cannot read, change or write A's profile", async () => {
      await withTenant(app, b, async (tx) => {
        expect(await tx.instituteProfile.findMany()).toEqual([]);
        expect((await tx.instituteProfile.updateMany({ data: { nameEn: 'X' } })).count).toBe(0);
      });
      await expect(
        withTenant(app, b, (tx) =>
          tx.instituteProfile.create({ data: { tenantId: c, nameEn: 'C' } }),
        ),
      ).rejects.toThrow();
    });

    it('one per institute, never deleted', async () => {
      await expect(
        withTenant(app, a, (tx) =>
          tx.instituteProfile.create({ data: { tenantId: a, nameEn: 'Again' } }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM institute_profiles`),
      ).rejects.toThrow(/permission denied/);
    });

    it.each([
      ['no name', { nameBn: null, nameEn: null }],
      ['a 5-digit EIIN', { eiin: '12345' }],
      ['letters in the EIIN', { eiin: '12345a' }],
      ['letters in the phone', { phone: 'abc12345' }],
      ['a 4-digit phone', { phone: '1234' }],
      ['an e-mail without a domain', { email: 'x@' }],
      ['an ftp website', { website: 'ftp://example.com' }],
      ['year 1700', { establishedYear: 1700 }],
      ['a 31-character short name', { shortName: 'x'.repeat(31) }],
    ])('refuses %s', async (_name, data) => {
      await expect(
        withTenant(app, a, (tx) => tx.instituteProfile.updateMany({ data })),
      ).rejects.toThrow();
    });

    it('accepts a full, valid profile', async () => {
      const n = await withTenant(app, a, (tx) =>
        tx.instituteProfile.updateMany({
          data: {
            nameEn: 'Shapla High School',
            shortName: 'SHS',
            eiin: '108123',
            phone: '+8801711000000',
            email: 'office@shapla.edu.bd',
            website: 'https://shapla.edu.bd',
            establishedYear: 1965,
            headTitleBn: 'প্রধান শিক্ষক',
            headNameEn: 'Md. Rahim',
          },
        }),
      );
      expect(n.count).toBe(1);
    });

    it("cannot point at another institute's file; a file in use cannot be deleted", async () => {
      const bLogo = await putFile(b, 'LOGO', 'image/png', 100);
      await expect(
        withTenant(app, a, (tx) => tx.instituteProfile.updateMany({ data: { logoFileId: bLogo } })),
      ).rejects.toThrow();
      const aLogo = await putFile(a, 'LOGO', 'image/png', 100);
      await withTenant(app, a, (tx) =>
        tx.instituteProfile.updateMany({ data: { logoFileId: aLogo } }),
      );
      await expect(
        withTenant(app, a, (tx) =>
          tx.storedFile.delete({ where: { id: aLogo }, select: { id: true } }),
        ),
      ).rejects.toThrow();
      // One file is used in one place only.
      await expect(
        withTenant(app, a, (tx) => tx.instituteProfile.updateMany({ data: { sealFileId: aLogo } })),
      ).rejects.toThrow();
    });
  });

  describe('students.photo_file_id', () => {
    it("cannot point at another institute's file, and two students cannot share one", async () => {
      const { student } = await createStudent(app, a, 'P-1');
      const { student: other } = await createStudent(app, a, 'P-2');
      const bPhoto = await putFile(b);
      await expect(
        withTenant(app, a, (tx) =>
          tx.student.update({
            where: { id: student.id },
            data: { photoFileId: bPhoto },
            select: { id: true },
          }),
        ),
      ).rejects.toThrow();
      const photo = await putFile(a);
      await withTenant(app, a, (tx) =>
        tx.student.update({
          where: { id: student.id },
          data: { photoFileId: photo },
          select: { id: true },
        }),
      );
      await expect(
        withTenant(app, a, (tx) =>
          tx.student.update({
            where: { id: other.id },
            data: { photoFileId: photo },
            select: { id: true },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(app, a, (tx) =>
          tx.storedFile.delete({ where: { id: photo }, select: { id: true } }),
        ),
      ).rejects.toThrow();
    });

    it('students.photo_url is gone (never written; replaced by photo_file_id)', async () => {
      const cols = await app.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'students' AND column_name LIKE 'photo%' ORDER BY 1`;
      expect(cols.map((c) => c.column_name)).toEqual(['photo_file_id']);
    });
  });
});
