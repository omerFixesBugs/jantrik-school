'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StudentProfile } from '@jantrik/shared';
import { Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { ChooseImageButton, imageForm, useFilePreview } from '@/components/image-upload';
import { StudentAvatar } from '@/components/student-photo';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth/auth-provider';
import { useImageErrorMessage } from '@/lib/authed-image';

/**
 * Add, replace or remove a student's photo (OWNER/ADMIN). The chosen file is previewed locally;
 * the server shrinks it to passport size and removes hidden details (docs/files.md).
 */
export function PhotoDialog({
  profile,
  name,
  onClose,
}: {
  profile: StudentProfile;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('profile');
  const tErrors = useTranslations('errors');
  const describe = useImageErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const { file, preview, choose: setFile } = useFilePreview();
  const [error, setError] = useState<string | null>(null);

  const done = (p: StudentProfile, message: string) => {
    queryClient.setQueryData(['student', session?.tenant?.id, profile.id], p);
    void queryClient.invalidateQueries({ queryKey: ['students'] });
    toast.success(message);
    onClose();
  };
  const upload = useMutation({
    mutationFn: (f: File) =>
      client.api<StudentProfile>(`/students/${profile.id}/photo`, {
        method: 'PUT',
        body: imageForm(f),
      }),
    onSuccess: (p) => done(p, t('saved')),
    onError: (e) => setError(describe(e)),
  });
  const remove = useMutation({
    mutationFn: () =>
      client.api<StudentProfile>(`/students/${profile.id}/photo`, { method: 'DELETE' }),
    onSuccess: (p) => done(p, t('photoRemoved')),
    onError: (e) => setError(describe(e)),
  });
  const pending = upload.isPending || remove.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="photo-dialog">
        <DialogHeader>
          <DialogTitle>{t('photoTitle', { name })}</DialogTitle>
          <DialogDescription>{t('photoHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={t('photoPreview')}
              className="h-40 w-32 rounded-lg border object-cover"
              data-testid="photo-preview"
            />
          ) : (
            <StudentAvatar
              studentId={profile.id}
              photoId={profile.photoId}
              name={name}
              size="xl"
              className="size-32"
            />
          )}
          {!preview && !profile.photoId && (
            <span className="text-muted-foreground text-sm">{t('photoNone')}</span>
          )}
          <ChooseImageButton
            onChoose={(f) => {
              setError(null);
              setFile(f);
            }}
            onTooLarge={() => setError(tErrors('fileTooLarge'))}
            opaque
            disabled={pending}
            testId="photo-choose"
          >
            {t('photoChoose')}
          </ChooseImageButton>
          {error && (
            <p role="alert" className="text-destructive text-center text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {profile.photoId ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => remove.mutate()}
              data-testid="photo-remove"
            >
              <Trash2Icon aria-hidden />
              {t('photoRemove')}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            disabled={!file || pending}
            onClick={() => file && upload.mutate(file)}
            data-testid="photo-upload"
          >
            {t('photoUpload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
