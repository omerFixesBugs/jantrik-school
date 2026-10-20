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
  // Intl.Segmenter keeps a Bangla letter with its vowel signs (তা, রা). Firefox before 125 lacks
  // it: fall back to code points, which may split a sign off but never crashes the page.
  const graphemes = (w: string) =>
    typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter().segment(w)].map((s) => s.segment)
      : Array.from(w);
  if (BANGLA.test(first)) return graphemes(first)[0] ?? '?';
  const last = words.length > 1 ? words.at(-1)! : '';
  return (graphemes(first)[0]! + (last ? graphemes(last)[0]! : '')).toUpperCase();
}

/** Soft chalk colours (mint, yellow, sky, pink, orange), each with a dark ink at ≥ 7:1. */
const TONES = [
  'bg-[#dcefe4] text-[#173f35]',
  'bg-[#fbf1cf] text-[#5c4706]',
  'bg-[#ddeef7] text-[#1d4d6b]',
  'bg-[#f9e2ea] text-[#7a2846]',
  'bg-[#fbe8d6] text-[#6e3a0c]',
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
