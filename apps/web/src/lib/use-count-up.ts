'use client';

import { useLayoutEffect, useRef, useState } from 'react';

const still = () =>
  !('IntersectionObserver' in window) ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that counts up from zero the first time its element comes into view (600 ms,
 * exponential ease-out), once per mount; later changes show at once. Under
 * prefers-reduced-motion, or without IntersectionObserver, it is the final number throughout.
 * Show the result `aria-hidden` and the final value to screen readers, which should never hear
 * the count.
 */
export function useCountUp<T extends Element>(target: number, duration = 600) {
  const ref = useRef<T | null>(null);
  const [value, setValue] = useState(target);
  const done = useRef(false);

  // A layout effect: the count starts at zero before the first paint, so the final number
  // never flashes first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || done.current || still()) {
      setValue(target);
      return;
    }
    setValue(0);
    let frame = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      done.current = true;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        setValue(t === 1 ? target : target * (1 - 2 ** (-10 * t)));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      // Cut short (unmounted, or the number changed): the next run shows the number at once.
      if (frame) done.current = true;
    };
  }, [target, duration]);

  return [ref, value] as const;
}
