'use client';

import { UPLOAD_ACCEPT, UPLOAD_MAX_BYTES } from '@jantrik/shared';
import { ImageUpIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

/**
 * The chosen file and an object URL to preview it. The URL is made when a file is chosen (not in
 * an effect) and revoked when another is chosen or the view goes.
 */
export function useFilePreview(): {
  file: File | null;
  preview: string | null;
  choose: (file: File | null) => void;
} {
  const [chosen, setChosen] = useState<{ file: File; url: string } | null>(null);
  const current = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  const choose = useCallback((file: File | null) => {
    if (current.current) URL.revokeObjectURL(current.current);
    const url = file ? URL.createObjectURL(file) : null;
    current.current = url;
    setChosen(file && url ? { file, url } : null);
  }, []);
  return { file: chosen?.file ?? null, preview: chosen?.url ?? null, choose };
}

/** The body of an image upload: the field `file`, as the API's multipart routes expect. */
export function imageForm(file: File): FormData {
  const form = new FormData();
  form.append('file', file);
  return form;
}
