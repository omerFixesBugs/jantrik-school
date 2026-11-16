// Stored images (sprint 1 P2, docs/files.md): the kinds, their caps and the API's shapes. No zod
// here: the web imports these; the input schema is in files-schema.ts.

export const STORED_FILE_KINDS = [
  'STUDENT_PHOTO',
  'APPLICANT_PHOTO',
  'LOGO',
  'SIGNATURE',
  'SEAL',
  'DOCUMENT_ASSET',
] as const;
export type StoredFileKind = (typeof STORED_FILE_KINDS)[number];

export type StoredMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface FileLimit {
  /** Stored size cap in bytes (the database CHECK stored_files_size has the same numbers). */
  maxBytes: number;
  /** The box the image is shrunk to fit (never enlarged); null: no resize (P8's assets). */
  box: { width: number; height: number } | null;
  /** Formats stored for this kind, preferred first (CHECK stored_files_mime). */
  mimes: readonly StoredMime[];
}

/** Per kind, what the server stores after re-encoding the upload (decision S7). */
export const FILE_LIMITS: Record<StoredFileKind, FileLimit> = {
  STUDENT_PHOTO: { maxBytes: 200 * 1024, box: { width: 600, height: 800 }, mimes: ['image/jpeg'] },
  APPLICANT_PHOTO: {
    maxBytes: 200 * 1024,
    box: { width: 600, height: 800 },
    mimes: ['image/jpeg'],
  },
  LOGO: {
    maxBytes: 100 * 1024,
    box: { width: 512, height: 512 },
    mimes: ['image/png', 'image/webp'],
  },
  SEAL: {
    maxBytes: 100 * 1024,
    box: { width: 512, height: 512 },
    mimes: ['image/png', 'image/webp'],
  },
  SIGNATURE: { maxBytes: 100 * 1024, box: { width: 600, height: 240 }, mimes: ['image/png'] },
  DOCUMENT_ASSET: {
    maxBytes: 256 * 1024,
    box: null,
    mimes: ['image/jpeg', 'image/png', 'image/webp'],
  },
};

/** The largest upload the API reads (multer `fileSize`); the web checks it before sending. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Decoded pixels allowed (sharp `limitInputPixels`): a 48 MP phone photo fits, a bomb does not. */
export const UPLOAD_MAX_PIXELS = 50_000_000;
/** What the file picker offers (the server decides by content, not by this). */
export const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp';

/** The institute profile's three images, by their route name. */
export const INSTITUTE_IMAGE_SLOTS = ['logo', 'signature', 'seal'] as const;
export type InstituteImageSlot = (typeof INSTITUTE_IMAGE_SLOTS)[number];
export const INSTITUTE_IMAGE_KIND: Record<InstituteImageSlot, StoredFileKind> = {
  logo: 'LOGO',
  signature: 'SIGNATURE',
  seal: 'SEAL',
};

/** A stored image as the API describes it (never its bytes; those come from an entity route). */
export interface FileRef {
  /** The stored file's id: also the web's cache key (a replaced image has a new id). */
  id: string;
  mime: StoredMime;
  sizeBytes: number;
  width: number;
  height: number;
}

/** The text fields of the institute profile (PUT /institute/profile). */
export interface InstituteProfileFields {
  nameBn: string | null;
  nameEn: string | null;
  shortName: string | null;
  /** BANBEIS EIIN: 6 ASCII digits. */
  eiin: string | null;
  addressBn: string | null;
  addressEn: string | null;
  /** A mobile as E.164, or a landline as ASCII digits (optional leading +). */
  phone: string | null;
  email: string | null;
  website: string | null;
  headTitleBn: string | null;
  headTitleEn: string | null;
  headNameBn: string | null;
  headNameEn: string | null;
  establishedYear: number | null;
}

/** GET /institute/profile. */
export interface InstituteProfile extends InstituteProfileFields {
  /** False until the first save or image: the fields are then empty. */
  saved: boolean;
  /** The name the platform registered (tenants.name), to pre-fill a new profile. */
  registeredName: string;
  logo: FileRef | null;
  signature: FileRef | null;
  seal: FileRef | null;
  /** This institute's stored images in total, and its cap (FILE_STORAGE_PER_TENANT_MB). */
  storage: { bytesUsed: number; capBytes: number };
}

/** Field limits shared by the schema and the form (the CHECKs on institute_profiles). */
export const INSTITUTE_PROFILE_LIMITS = {
  name: 200,
  shortName: 30,
  address: 300,
  headTitle: 60,
  headName: 100,
  email: 254,
  website: 200,
  yearMin: 1800,
  yearMax: 2100,
} as const;
