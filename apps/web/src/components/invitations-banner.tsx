'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffInvitation } from '@jantrik/shared';
import { MailOpenIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';

/**
 * Pending staff invitations from other institutes, for someone already signed in:
 * "<institute> added you as <role>: accept / decline". Access there starts only on accept.
 */
export function InvitationsBanner() {
  const t = useTranslations('dashboard');
  const tRoles = useTranslations('roles');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = ['invitations', session?.user.id];
  const invitations = useQuery({
    queryKey: key,
    queryFn: () => client.api<StaffInvitation[]>('/me/invitations'),
  });
  const answer = useMutation({
    mutationFn: ({
      tenantId,
      accept,
      roles,
    }: {
      tenantId: string;
      accept: boolean;
      roles: string[];
    }) =>
      client.api(`/me/invitations/${tenantId}/${accept ? 'accept' : 'decline'}`, {
        method: 'POST',
        json: accept ? { roles } : undefined,
      }),
    onSuccess: (_, v) => {
      if (v.accept) toast.success(t('inviteAccepted'));
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ['memberships'] });
    },
    onError: (e) => {
      toast.error(describe(e));
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  if (!invitations.data || invitations.data.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" data-testid="invitations-banner">
      {invitations.data.map((i) => (
        <li
          key={i.tenant.id}
          className="border-primary/40 bg-primary-soft/40 flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center"
        >
          <span className="flex min-w-0 flex-1 items-start gap-3">
            <MailOpenIcon aria-hidden className="text-primary-ink mt-0.5 size-5 shrink-0" />
            <span className="font-medium break-words">
              {t('inviteBanner', {
                institute: i.tenant.name,
                roles: i.roles.map((r) => tRoles(r)).join(', '),
              })}
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ tenantId: i.tenant.id, accept: true, roles: i.roles })}
            >
              {t('inviteAccept')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={answer.isPending}
              onClick={() =>
                answer.mutate({ tenantId: i.tenant.id, accept: false, roles: i.roles })
              }
            >
              {t('inviteDecline')}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
