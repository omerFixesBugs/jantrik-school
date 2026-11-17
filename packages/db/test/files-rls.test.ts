import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient, type StoredFileKind } from '../src/index.js';
import { appClient, createStudent, createTenant } from './helpers.js';

// Sprint 1 P2 (docs/plans/sprint-1-p2-files.md): stored_files, stored_file_usage,
// institute_profiles and students.photo_file_id. Tenant isolation, the grants (no UPDATE of a
// file, no DELETE of usage or profile), the CHECKs that back the per-kind caps, and the composite
// foreign keys that keep a row from pointing at another institute's file, or at a file of another
// kind. Each refusal names the rule that refused it.

type Mime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'text/plain';

/** What refuses a write: a CHECK or foreign key by name, or RLS, or a unique index. */
const RLS = /row-level security/;
const UNIQUE = /Unique constraint/;

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
      ).rejects.toThrow(RLS);
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

    it.each<[string, StoredFileKind, Mime, number, Parameters<typeof fileData>[4], string]>([
      ['an unknown mime', 'DOCUMENT_ASSET', 'text/plain', 10, {}, 'stored_files_mime'],
      ['a GIF', 'DOCUMENT_ASSET', 'image/gif', 10, {}, 'stored_files_mime'],
      ['a PNG photo', 'STUDENT_PHOTO', 'image/png', 10, {}, 'stored_files_mime'],
      ['a JPEG signature', 'SIGNATURE', 'image/jpeg', 10, {}, 'stored_files_mime'],
      ['a JPEG logo', 'LOGO', 'image/jpeg', 10, {}, 'stored_files_mime'],
      ['a photo over 200 KB', 'STUDENT_PHOTO', 'image/jpeg', 204_801, {}, 'stored_files_size'],
      [
        'an applicant photo over 200 KB',
        'APPLICANT_PHOTO',
        'image/jpeg',
        204_801,
        {},
        'stored_files_size',
      ],
      ['a logo over 100 KB', 'LOGO', 'image/png', 102_401, {}, 'stored_files_size'],
      ['a seal over 100 KB', 'SEAL', 'image/webp', 102_401, {}, 'stored_files_size'],
      ['a signature over 100 KB', 'SIGNATURE', 'image/png', 102_401, {}, 'stored_files_size'],
      [
        'a document asset over 256 KB',
        'DOCUMENT_ASSET',
        'image/png',
        262_145,
        {},
        'stored_files_size',
      ],
      [
        'a size that is not the bytes’ length',
        'STUDENT_PHOTO',
        'image/jpeg',
        10,
        { sizeBytes: 9 },
        'stored_files_size',
      ],
      [
        'a malformed sha256',
        'STUDENT_PHOTO',
        'image/jpeg',
        10,
        { sha256: 'ABC' },
        'stored_files_sha256',
      ],
      ['width 0', 'STUDENT_PHOTO', 'image/jpeg', 10, { width: 0 }, 'stored_files_dimensions'],
      [
        'height over 4000',
        'STUDENT_PHOTO',
        'image/jpeg',
        10,
        { height: 4001 },
        'stored_files_dimensions',
      ],
    ])('refuses %s', async (_name, kind, mime, size, over, rule) => {
      await expect(
        withTenant(app, a, (tx) =>
          tx.storedFile.create({ data: fileData(a, kind, mime, size, over), select: { id: true } }),
        ),
      ).rejects.toThrow(rule);
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
      ).rejects.toThrow(RLS);
      await expect(
        withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM stored_file_usage`),
      ).rejects.toThrow(/permission denied/);
      for (const data of [{ bytesUsed: -1 }, { fileCount: -1 }]) {
        await expect(
          withTenant(app, a, (tx) => tx.storedFileUsage.updateMany({ data })),
        ).rejects.toThrow('stored_file_usage_non_negative');
      }
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
      ).rejects.toThrow(RLS);
    });

    it('one per institute, never deleted', async () => {
      await expect(
        withTenant(app, a, (tx) =>
          tx.instituteProfile.create({ data: { tenantId: a, nameEn: 'Again' } }),
        ),
      ).rejects.toThrow(UNIQUE);
      await expect(
        withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM institute_profiles`),
      ).rejects.toThrow(/permission denied/);
    });

    it.each([
      ['no name', { nameBn: null, nameEn: null }, 'institute_profiles_name'],
      ['a 5-digit EIIN', { eiin: '12345' }, 'institute_profiles_eiin'],
      ['letters in the EIIN', { eiin: '12345a' }, 'institute_profiles_eiin'],
      ['letters in the phone', { phone: 'abc12345' }, 'institute_profiles_phone'],
      ['a 4-digit phone', { phone: '1234' }, 'institute_profiles_phone'],
      ['an e-mail without a domain', { email: 'x@' }, 'institute_profiles_email'],
      ['an ftp website', { website: 'ftp://example.com' }, 'institute_profiles_website'],
      ['an upper-case scheme', { website: 'HTTPS://example.com' }, 'institute_profiles_website'],
      ['year 1700', { establishedYear: 1700 }, 'institute_profiles_established_year'],
      ['a 31-character short name', { shortName: 'x'.repeat(31) }, 'institute_profiles_lengths'],
      [
        'another kind in a kind column',
        { logoFileKind: 'SEAL' as const },
        'institute_profiles_file_kinds',
      ],
    ])('refuses %s', async (_name, data, rule) => {
      await expect(
        withTenant(app, a, (tx) => tx.instituteProfile.updateMany({ data })),
      ).rejects.toThrow(rule);
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

    it("cannot point at another institute's file or another kind; a file in use cannot be deleted", async () => {
      const bLogo = await putFile(b, 'LOGO', 'image/png', 100);
      await expect(
        withTenant(app, a, (tx) => tx.instituteProfile.updateMany({ data: { logoFileId: bLogo } })),
      ).rejects.toThrow('institute_profiles_tenant_id_logo_file_id_logo_file_kind_fkey');
      // A photo is not a logo, and a logo is not a seal.
      const aPhoto = await putFile(a, 'STUDENT_PHOTO', 'image/jpeg', 100);
      await expect(
        withTenant(app, a, (tx) =>
          tx.instituteProfile.updateMany({ data: { logoFileId: aPhoto } }),
        ),
      ).rejects.toThrow('institute_profiles_tenant_id_logo_file_id_logo_file_kind_fkey');
      await expect(
        withTenant(app, a, (tx) =>
          tx.instituteProfile.updateMany({ data: { headSignatureFileId: aPhoto } }),
        ),
      ).rejects.toThrow('institute_profiles_tenant_id_head_signature_file_id_head_s_fkey');
      const aLogo = await putFile(a, 'LOGO', 'image/png', 100);
      await expect(
        withTenant(app, a, (tx) => tx.instituteProfile.updateMany({ data: { sealFileId: aLogo } })),
      ).rejects.toThrow('institute_profiles_tenant_id_seal_file_id_seal_file_kind_fkey');
      await withTenant(app, a, (tx) =>
        tx.instituteProfile.updateMany({ data: { logoFileId: aLogo } }),
      );
      await expect(
        withTenant(app, a, (tx) =>
          tx.storedFile.delete({ where: { id: aLogo }, select: { id: true } }),
        ),
      ).rejects.toThrow('institute_profiles_tenant_id_logo_file_id_logo_file_kind_fkey');
    });
  });

  it('a first image and a first save at once: the insert waits for the held one, then skips it', async () => {
    // InstituteProfileService.ensureRow inserts with ON CONFLICT DO NOTHING (createMany
    // skipDuplicates) while PUT /institute/profile upserts. Hold an uncommitted insert, run the
    // second, commit the first: no error, nothing inserted twice, the first row stays.
    const t = (await createTenant(app)).id;
    const other = appClient();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedOnce = new Promise<void>((r) => (inserted = r));
    const first = withTenant(app, t, async (tx) => {
      await tx.instituteProfile.create({ data: { tenantId: t, nameEn: 'First save' } });
      inserted();
      await held;
    });
    await insertedOnce;
    const second = withTenant(other, t, (tx) =>
      tx.instituteProfile.createMany({
        data: [{ tenantId: t, nameEn: 'From the image' }],
        skipDuplicates: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 300)); // the second is now waiting on the first
    release();
    await first;
    expect((await second).count).toBe(0);
    const rows = await withTenant(app, t, (tx) =>
      tx.instituteProfile.findMany({ select: { nameEn: true } }),
    );
    expect(rows).toEqual([{ nameEn: 'First save' }]);
    await other.$disconnect();
  });

  describe('students.photo_file_id', () => {
    it("cannot point at another institute's file or a logo; two students cannot share one", async () => {
      const { student } = await createStudent(app, a, 'P-1');
      const { student: other } = await createStudent(app, a, 'P-2');
      const setPhoto = (id: string, photoFileId: string) =>
        withTenant(app, a, (tx) =>
          tx.student.update({ where: { id }, data: { photoFileId }, select: { id: true } }),
        );
      const FK = 'students_tenant_id_photo_file_id_photo_file_kind_fkey';
      await expect(setPhoto(student.id, await putFile(b))).rejects.toThrow(FK);
      await expect(
        setPhoto(student.id, await putFile(a, 'LOGO', 'image/png', 100)),
      ).rejects.toThrow(FK);
      const photo = await putFile(a);
      await setPhoto(student.id, photo);
      await expect(setPhoto(other.id, photo)).rejects.toThrow(UNIQUE);
      await expect(
        withTenant(app, a, (tx) =>
          tx.storedFile.delete({ where: { id: photo }, select: { id: true } }),
        ),
      ).rejects.toThrow(FK);
      await expect(
        withTenant(app, a, (tx) =>
          tx.student.update({
            where: { id: student.id },
            data: { photoFileKind: 'LOGO' },
            select: { id: true },
          }),
        ),
      ).rejects.toThrow('students_photo_file_kind');
    });

    it('students.photo_url is gone (never written; replaced by photo_file_id)', async () => {
      const cols = await app.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'students' AND column_name LIKE 'photo%' ORDER BY 1`;
      expect(cols.map((c) => c.column_name)).toEqual(['photo_file_id', 'photo_file_kind']);
    });
  });
});
