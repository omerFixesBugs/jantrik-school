import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  ParseEnumPipe,
  Put,
  Req,
  Res,
  UploadedFile,
} from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  INSTITUTE_IMAGE_KIND,
  INSTITUTE_IMAGE_SLOTS,
  instituteProfileSchema,
  type FileRef,
  type InstituteImageSlot,
  type InstituteProfile,
  type InstituteProfileFields,
} from '@jantrik/shared';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.module.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { zodDto } from '../common/zod.js';
import { FILE_STORE, type FileStore, type StoredFileMeta } from '../files/file-store.js';
import {
  ImageUpload,
  ImageUploads,
  sendStoredImage,
  type UploadedImage,
} from '../files/files.module.js';
import { Db } from '../tenancy/db.service.js';

class InstituteProfileDto extends zodDto(instituteProfileSchema) {}

/** The profile column holding each slot's file. */
const COLUMN = {
  logo: 'logoFileId',
  signature: 'headSignatureFileId',
  seal: 'sealFileId',
} as const satisfies Record<InstituteImageSlot, keyof Prisma.InstituteProfileUncheckedCreateInput>;

const FIELDS = [
  'nameBn',
  'nameEn',
  'shortName',
  'eiin',
  'addressBn',
  'addressEn',
  'phone',
  'email',
  'website',
  'headTitleBn',
  'headTitleEn',
  'headNameBn',
  'headNameEn',
  'establishedYear',
] as const satisfies readonly (keyof InstituteProfileFields)[];

const BANGLA = /[ঀ-৿]/;

/**
 * The institute's own profile (sprint 1 P2, docs/files.md): names, EIIN, contact, the head of the
 * institute, and three images. One row per institute, created on the first save or image (no
 * backfill). Every change is audited; images through FileStore only.
 */
@Injectable()
export class InstituteProfileService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly uploads: ImageUploads,
    @Inject(FILE_STORE) private readonly files: FileStore,
  ) {}

  private row() {
    return this.db.tx.instituteProfile.findFirst();
  }

  async get(): Promise<InstituteProfile> {
    const tenant = await this.db.tx.tenant.findFirstOrThrow({
      where: { id: this.context.requireTenantId() },
      select: { name: true },
    });
    const row = await this.row();
    const ref = async (id: string | null | undefined): Promise<FileRef | null> => {
      const meta = id ? await this.files.meta(id) : null;
      return meta ? fileRef(meta) : null;
    };
    const fields = Object.fromEntries(
      FIELDS.map((f) => [f, row?.[f] ?? null]),
    ) as unknown as InstituteProfileFields;
    return {
      ...fields,
      saved: row !== null,
      registeredName: tenant.name,
      logo: await ref(row?.logoFileId),
      signature: await ref(row?.headSignatureFileId),
      seal: await ref(row?.sealFileId),
      storage: await this.files.usage(),
    };
  }

  async update(input: InstituteProfileFields): Promise<InstituteProfile> {
    const tenantId = this.context.requireTenantId();
    const before = await this.row();
    const data = Object.fromEntries(
      FIELDS.map((f) => [f, input[f]]),
    ) as unknown as InstituteProfileFields;
    const old = before ? Object.fromEntries(FIELDS.map((f) => [f, before[f]])) : null;
    const changed = !old || FIELDS.some((f) => old[f] !== data[f]);
    if (changed) {
      const row = await this.db.tx.instituteProfile.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
        select: { id: true },
      });
      await this.audit.record({
        entity: 'institute_profile',
        entityId: row.id,
        action: before ? 'UPDATE' : 'CREATE',
        ...(old ? { oldValues: old } : {}),
        newValues: data as unknown as Prisma.InputJsonValue,
      });
    }
    return this.get();
  }

  /**
   * Sets (or replaces) one image; the replaced file is deleted in the same transaction (F10). The
   * store holds the institute's file lock from here to commit, so the old id read below is final.
   */
  async setImage(slot: InstituteImageSlot, upload: UploadedImage | undefined) {
    const stored = await this.uploads.store(INSTITUTE_IMAGE_KIND[slot], upload);
    const profile = await this.ensureRow();
    const oldId = profile[COLUMN[slot]];
    await this.db.tx.instituteProfile.update({
      where: { id: profile.id },
      data: { [COLUMN[slot]]: stored.id },
      select: { id: true },
    });
    if (oldId) await this.files.delete(oldId);
    await this.audit.record({
      entity: 'institute_profile',
      entityId: profile.id,
      action: 'UPDATE',
      oldValues: { image: slot, fileId: oldId },
      newValues: { image: slot, fileId: stored.id },
    });
    return this.get();
  }

  async removeImage(slot: InstituteImageSlot): Promise<InstituteProfile> {
    await this.files.lock();
    const profile = await this.row();
    const oldId = profile?.[COLUMN[slot]];
    if (profile && oldId) {
      await this.db.tx.instituteProfile.update({
        where: { id: profile.id },
        data: { [COLUMN[slot]]: null },
        select: { id: true },
      });
      await this.files.delete(oldId);
      await this.audit.record({
        entity: 'institute_profile',
        entityId: profile.id,
        action: 'UPDATE',
        oldValues: { image: slot, fileId: oldId },
        newValues: { image: slot, fileId: null },
      });
    }
    return this.get();
  }

  /** The image's file id for serving, or null. */
  async imageId(slot: InstituteImageSlot): Promise<string | null> {
    return (await this.row())?.[COLUMN[slot]] ?? null;
  }

  /**
   * The profile row, created for an image uploaded before the first save (F6) with the
   * registered name in the matching script, so the "one name" CHECK holds.
   */
  private async ensureRow() {
    const existing = await this.row();
    if (existing) return existing;
    const tenantId = this.context.requireTenantId();
    const { name } = await this.db.tx.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const names = BANGLA.test(name)
      ? { nameBn: name.slice(0, 200) }
      : { nameEn: name.slice(0, 200) };
    const row = await this.db.tx.instituteProfile.create({ data: { tenantId, ...names } });
    await this.audit.record({
      entity: 'institute_profile',
      entityId: row.id,
      action: 'CREATE',
      newValues: names,
    });
    return row;
  }
}

function fileRef(meta: StoredFileMeta): FileRef {
  return {
    id: meta.id,
    mime: meta.mime,
    sizeBytes: meta.sizeBytes,
    width: meta.width,
    height: meta.height,
  };
}

const Slot = () => Param('slot', new ParseEnumPipe(INSTITUTE_IMAGE_SLOTS));

@Controller('institute/profile')
@RequireModule('CORE')
export class InstituteProfileController {
  constructor(
    private readonly profile: InstituteProfileService,
    @Inject(FILE_STORE) private readonly files: FileStore,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  get(): Promise<InstituteProfile> {
    return this.profile.get();
  }

  @Put()
  @Roles('OWNER', 'ADMIN')
  update(@Body() dto: InstituteProfileDto): Promise<InstituteProfile> {
    return this.profile.update(dto as unknown as InstituteProfileFields);
  }

  /** The logo is the institute's public face: every member may see it, guardians too (F1). */
  @Get('logo')
  @Roles('OWNER', 'ADMIN', 'TEACHER', 'ACCOUNTANT', 'STAFF', 'GUARDIAN')
  async logo(@Req() req: Request, @Res() res: Response): Promise<void> {
    await sendStoredImage(this.files, await this.profile.imageId('logo'), req, res);
  }

  /** The head's signature and the seal could be misused on forged papers: owner and admin (F1). */
  @Get(':slot')
  @Roles('OWNER', 'ADMIN')
  async image(
    @Slot() slot: InstituteImageSlot,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await sendStoredImage(this.files, await this.profile.imageId(slot), req, res);
  }

  /** multipart/form-data with `file` (JPEG, PNG or WebP, at most 5 MB). */
  @Put(':slot')
  @Roles('OWNER', 'ADMIN')
  @ImageUpload()
  setImage(
    @Slot() slot: InstituteImageSlot,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<InstituteProfile> {
    return this.profile.setImage(slot, file);
  }

  @Delete(':slot')
  @Roles('OWNER', 'ADMIN')
  removeImage(@Slot() slot: InstituteImageSlot): Promise<InstituteProfile> {
    return this.profile.removeImage(slot);
  }
}

@Module({ controllers: [InstituteProfileController], providers: [InstituteProfileService] })
export class InstituteProfileModule {}
