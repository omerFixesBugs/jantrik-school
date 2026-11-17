'use client';

import { UPLOAD_ACCEPT, UPLOAD_MAX_BYTES } from '@jantrik/shared';
import { ImageUpIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { shrinkForUpload } from '@/lib/image-shrink';

/**
 * A "choose image" button around a hidden file input. The chosen image is shrunk in the browser
 * first (image-shrink.ts: a phone photo becomes about 300 KB); a file still over 5 MB is refused
 * here with the server's own message, before anything is sent. The server decides the rest by
 * content. `opaque`: a photo (sent as JPEG); otherwise transparency is kept (PNG).
 */
export function ChooseImageButton({
  onChoose,
  onTooLarge,
  opaque,
  children,
  variant = 'outline',
  size,
  disabled,
  testId,
}: {
  onChoose: (file: File) => void;
  onTooLarge: () => void;
  opaque: boolean;
  children: ReactNode;
  variant?: 'outline' | 'default' | 'ghost';
  size?: 'sm' | 'default';
  disabled?: boolean;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [shrinking, setShrinking] = useState(false);
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
          setShrinking(true);
          void shrinkForUpload(file, opaque)
            .then((ready) => (ready.size > UPLOAD_MAX_BYTES ? onTooLarge() : onChoose(ready)))
            .finally(() => setShrinking(false));
        }}
      />
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled || shrinking}
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
