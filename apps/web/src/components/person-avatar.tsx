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

/**
 * Soft tints (mint, yellow, sky, pink, orange) that tell people apart, each with an ink at ≥ 7:1;
 * in dark mode a deep tint with a light ink, so an avatar never glares on a dark card.
 */
const TONES = [
  'bg-[#dcefe4] text-[#173f35] dark:bg-[#173a2b] dark:text-[#a8e0c2]',
  'bg-[#fbf1cf] text-[#5c4706] dark:bg-[#3a3012] dark:text-[#f1d98a]',
  'bg-[#ddeef7] text-[#1d4d6b] dark:bg-[#132f44] dark:text-[#a9d4ef]',
  'bg-[#f9e2ea] text-[#7a2846] dark:bg-[#3d1a28] dark:text-[#f3b5ca]',
  'bg-[#fbe8d6] text-[#6e3a0c] dark:bg-[#3d2512] dark:text-[#f6c49a]',
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
