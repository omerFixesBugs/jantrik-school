'use client';

import { UPLOAD_ACCEPT, UPLOAD_MAX_BYTES } from '@jantrik/shared';
import { ImageUpIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A "choose image" button around a hidden file input. A file over 5 MB is refused here with the
 * server's own message, before anything is sent; the server decides the rest by content.
 */
export function ChooseImageButton({
  onChoose,
  onTooLarge,
  children,
  variant = 'outline',
  size,
  disabled,
  testId,
}: {
  onChoose: (file: File) => void;
  onTooLarge: () => void;
  children: ReactNode;
  variant?: 'outline' | 'default' | 'ghost';
  size?: 'sm' | 'default';
  disabled?: boolean;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <>
      <input
        ref={input}
        id={id}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // the same file can be chosen again after an error
          if (!file) return;
          if (file.size > UPLOAD_MAX_BYTES) onTooLarge();
          else onChoose(file);
        }}
      />
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        onClick={() => input.current?.click()}
        data-testid={testId}
      >
        <ImageUpIcon aria-hidden />
        {children}
      </Button>
    </>
  );
}

/** An object URL for a chosen file, revoked when the file changes or the view goes. */
export function useLocalPreview(file: File | null): string | null {
  const [url, setUrl] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl({ file, url: next });
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return file && url?.file === file ? url.url : null;
}

/** The body of an image upload: the field `file`, as the API's multipart routes expect. */
export function imageForm(file: File): FormData {
  const form = new FormData();
  form.append('file', file);
  return form;
}
