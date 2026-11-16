'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';

// Stored images (docs/files.md) come from entity routes that need the bearer token, so an <img>
// cannot load them itself: they are fetched with AuthClient.download and shown as object URLs.
// One fetch per image and version (the file id), shared by every component that shows it.

const MAX_CACHED = 100;
const cache = new Map<string, Promise<string | null>>();

function load(download: (path: string) => Promise<Blob>, path: string, key: string) {
  let entry = cache.get(key);
  if (entry) return entry;
  entry = download(path)
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => {
      cache.delete(key); // not found or offline: try again next time
      return null;
    });
  cache.set(key, entry);
  if (cache.size > MAX_CACHED) {
    const [oldest, url] = cache.entries().next().value!;
    cache.delete(oldest);
    void url.then((u) => u && URL.revokeObjectURL(u));
  }
  return entry;
}

/**
 * An object URL for an authenticated image route, or null (no image, loading, or not allowed).
 * `version` is the stored file's id: a replaced image has a new one and is fetched again.
 */
export function useAuthedImage(path: string | null, version: string | null): string | null {
  const { client } = useAuth();
  const key = path && version ? `${path}#${version}` : null;
  const [shown, setShown] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key || !path) return;
    let live = true;
    void load((p) => client.download(p), path, key).then((url) => {
      if (live) setShown({ key, url });
    });
    return () => {
      live = false;
    };
  }, [client, key, path]);
  return key && shown?.key === key ? shown.url : null;
}

/** The message for a failed image upload: the image codes, else the usual ones. */
export function useImageErrorMessage() {
  const t = useTranslations('errors');
  const describe = useErrorMessage();
  return useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        if (error.code === 'IMAGE_INVALID') return t('imageInvalid');
        if (error.code === 'IMAGE_TOO_BIG') return t('imageTooBig');
        if (error.code === 'IMAGE_CANNOT_SHRINK') return t('imageCannotShrink');
        if (error.code === 'STORAGE_FULL') return t('storageFull');
        if (error.status === 413) return t('fileTooLarge');
      }
      return describe(error);
    },
    [t, describe],
  );
}
