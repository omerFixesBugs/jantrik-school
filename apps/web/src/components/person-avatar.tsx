import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

const HONORIFICS = /^(md\.?|mohammad|muhammad|mst\.?|mrs?\.?|dr\.?|মোঃ|মো\.|মোছাঃ|ডাঃ|ড\.)$/i;
const BANGLA = /[ঀ-৿]/;

/**
 * Initials for an avatar. Latin names: two initials ("TR"). Bangla names: the first letter
 * cluster (grapheme), since two Bangla initials don't read as a name. Honorifics are skipped.
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !HONORIFICS.test(w));
  const first = words[0] ?? name.trim();
  if (!first) return '?';
  const graphemes = (w: string) => [...new Intl.Segmenter().segment(w)].map((s) => s.segment);
  if (BANGLA.test(first)) return graphemes(first)[0] ?? '?';
  const last = words.length > 1 ? words.at(-1)! : '';
  return (graphemes(first)[0]! + (last ? graphemes(last)[0]! : '')).toUpperCase();
}

const TONES = [
  'bg-[#dcefe8] text-[#0b4a3f] dark:bg-[#173a33] dark:text-[#bfe9de]',
  'bg-[#fbeccb] text-[#6b4a07] dark:bg-[#3a2f15] dark:text-[#f5d58e]',
  'bg-[#dcebf5] text-[#1d4d6b] dark:bg-[#16303f] dark:text-[#a9d3ea]',
  'bg-[#f6e1e8] text-[#7a2846] dark:bg-[#3b1d27] dark:text-[#f0b5c8]',
  'bg-[#e9e3f5] text-[#4a3577] dark:bg-[#2a2240] dark:text-[#cdbdf0]',
];

/** Same name → same soft colour, so people learn to recognise each other at a glance. */
function tone(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return TONES[h % TONES.length]!;
}

export function PersonAvatar({
  name,
  photoUrl,
  size = 'default',
  className,
}: {
  name: string;
  photoUrl?: string | null;
  size?: 'sm' | 'default' | 'lg' | 'xl';
  className?: string;
}) {
  return (
    <Avatar
      size={size === 'xl' ? 'lg' : size}
      className={cn(
        'after:border-transparent',
        size === 'default' && 'size-9',
        size === 'lg' && 'size-11',
        size === 'xl' && 'size-14',
        className,
      )}
    >
      {photoUrl && <AvatarImage src={photoUrl} alt="" />}
      <AvatarFallback
        className={cn(
          'font-heading font-semibold',
          size === 'sm' && 'text-xs',
          size === 'default' && 'text-sm',
          size === 'lg' && 'text-base',
          size === 'xl' && 'text-xl',
          tone(name),
        )}
      >
        <span aria-hidden>{initials(name)}</span>
      </AvatarFallback>
    </Avatar>
  );
}
