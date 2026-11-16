import { Inject, Injectable } from '@nestjs/common';
import type { StudentProfile } from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { FILE_STORE, type FileStore } from '../files/file-store.js';
import { ImageUploads, type UploadedImage } from '../files/files.module.js';
import { Db } from '../tenancy/db.service.js';
import { RequestTransaction } from '../tenancy/request-transaction.service.js';
import { StudentAccess } from './student-access.service.js';
import { StudentAdminService } from './student-admin.service.js';

/**
 * A student's photo (sprint 1 P2, docs/files.md): one STUDENT_PHOTO file per student, replaced
 * or removed by OWNER/ADMIN, seen by those who see the student's full record (decision F1). A replaced
 * photo's file is deleted in the same transaction (F10); the audit keeps both ids.
 */
@Injectable()
export class StudentPhotoService {
  constructor(
    private readonly db: Db,
    private readonly admin: StudentAdminService,
    private readonly access: StudentAccess,
    private readonly uploads: ImageUploads,
    private readonly audit: AuditService,
    private readonly transaction: RequestTransaction,
    @Inject(FILE_STORE) private readonly files: FileStore,
  ) {}

  /** The photo's file id for GET /students/:id/photo (404 when the caller may not see it). */
  async photoId(studentId: string): Promise<string | null> {
    const s = await this.db.tx.student.findUnique({
      where: { id: studentId },
      select: {
        photoFileId: true,
        deletedAt: true,
        enrolments: { where: { academicYear: { isCurrent: true } }, select: { sectionId: true } },
      },
    });
    if (!s) throw apiError(404, 'NOT_FOUND', 'Student not found');
    // The photo is part of the full record (GET /students/:id leaves it out of a teacher's basic
    // view): OWNER/ADMIN, or a teacher of the student's current section; a deactivated student's
    // only for OWNER/ADMIN (F1, F9). Anyone else gets 404, as for a student that does not exist.
    const scope = await this.access.scope();
    const current = s.enrolments[0]?.sectionId ?? null;
    if (!scope.full && (s.deletedAt || !StudentAccess.sees(scope, current))) {
      throw apiError(404, 'NOT_FOUND', 'Student not found');
    }
    return s.photoFileId;
  }

  /**
   * PUT /students/:id/photo, an @OwnTransaction route: the image is decoded and re-encoded first,
   * holding no database connection, then one short request transaction stores it (docs/auth.md →
   * Request pipeline). Inside it the institute's file lock comes before reading the old id, and
   * the cap counts the photo being replaced.
   */
  async set(studentId: string, upload: UploadedImage | undefined): Promise<StudentProfile> {
    const image = await this.uploads.prepare('STUDENT_PHOTO', upload);
    return this.transaction.run(async () => {
      await this.writable(studentId);
      await this.files.lock();
      const old = await this.current(studentId);
      const stored = await this.uploads.store(image, old);
      await this.db.tx.student.update({
        where: { id: studentId },
        data: { photoFileId: stored.id },
        select: { id: true },
      });
      if (old) await this.files.delete(old);
      await this.record(studentId, old, stored.id);
      return this.admin.view(studentId);
    });
  }

  async remove(studentId: string): Promise<StudentProfile> {
    await this.writable(studentId);
    await this.files.lock();
    const old = await this.current(studentId);
    if (old) {
      await this.db.tx.student.update({
        where: { id: studentId },
        data: { photoFileId: null },
        select: { id: true },
      });
      await this.files.delete(old);
      await this.record(studentId, old, null);
    }
    return this.admin.view(studentId);
  }

  private async current(studentId: string): Promise<string | null> {
    const s = await this.db.tx.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { photoFileId: true },
    });
    return s.photoFileId;
  }

  /** 404 for a student this institute does not have; 409 for a deactivated one (F9). */
  private async writable(studentId: string): Promise<void> {
    const s = await this.db.tx.student.findUnique({
      where: { id: studentId },
      select: { deletedAt: true },
    });
    if (!s) throw apiError(404, 'NOT_FOUND', 'Student not found');
    if (s.deletedAt) throw apiError(409, 'DEACTIVATED', 'This student is deactivated');
  }

  private record(studentId: string, oldId: string | null, newId: string | null) {
    return this.audit.record({
      entity: 'student',
      entityId: studentId,
      action: 'UPDATE',
      oldValues: { photoFileId: oldId },
      newValues: { photoFileId: newId },
    });
  }
}
