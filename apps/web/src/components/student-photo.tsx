'use client';

import { PersonAvatar } from '@/components/person-avatar';
import { useAuthedImage } from '@/lib/authed-image';
import { cn } from '@/lib/utils';

/** Where a student's photo comes from: staff routes, or a guardian's own child. */
export function studentPhotoPath(
  studentId: string,
  photoId: string | null,
  as: 'staff' | 'guardian' = 'staff',
): string | null {
  if (!photoId) return null;
  return as === 'guardian' ? `/me/children/${studentId}/photo` : `/students/${studentId}/photo`;
}

/** A student's avatar: the photo once loaded, the initials meanwhile or without one. */
export function StudentAvatar({
  studentId,
  photoId,
  name,
  as = 'staff',
  size,
  className,
}: {
  studentId: string;
  photoId: string | null;
  name: string;
  as?: 'staff' | 'guardian';
  size?: 'sm' | 'default' | 'lg' | 'xl';
  className?: string;
}) {
  const url = useAuthedImage(studentPhotoPath(studentId, photoId, as), photoId);
  return <PersonAvatar name={name} photoUrl={url} size={size} className={className} />;
}

/** The photo as a plain image (report cards); nothing until it has loaded. */
export function StudentPhoto({
  studentId,
  photoId,
  className,
}: {
  studentId: string;
  photoId: string | null;
  className?: string;
}) {
  const url = useAuthedImage(studentPhotoPath(studentId, photoId), photoId);
  if (!url) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className={cn('object-cover', className)} data-testid="student-photo" />
  );
}
