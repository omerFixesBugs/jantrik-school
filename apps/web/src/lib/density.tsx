'use client';

import { defaultDensity, isDensity, type Density, type Role } from '@jantrik/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DENSITY_LAST_KEY as LAST_KEY } from './density-script';

/**
 * Density (docs/design.md → Density): `data-density` on <html> switches the size tokens in
 * globals.css. The first paint uses the last density this browser showed (DENSITY_SCRIPT), then
 * the signed-in person's own choice, or the default for their role and screen.
 */

/** A person's own choice, per browser (office computers are shared). */
const userKey = (userId: string) => `jantrik.density.v1.user.${userId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
}

function apply(density: Density) {
  document.documentElement.setAttribute('data-density', density);
  write(LAST_KEY, density);
}

interface DensityControl {
  density: Density;
  setDensity: (density: Density) => void;
  toggle: () => void;
}

const DensityContext = createContext<DensityControl | null>(null);

/**
 * Applies the signed-in person's density: their saved choice, else the default for their most
 * senior role and this screen (`defaultDensity`). Rendered only in the browser, behind the
 * session; give it `key={userId}` so another person signing in starts from their own choice.
 */
export function DensityProvider({
  userId,
  role,
  platform,
  children,
}: {
  userId: string;
  role: Role | null;
  platform?: boolean;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<Density | null>(() => {
    const saved = read(userKey(userId));
    return isDensity(saved) ? saved : null;
  });
  const [fallback] = useState<Density>(() =>
    defaultDensity({ role, viewportWidth: window.innerWidth, platform }),
  );
  const density = chosen ?? fallback;

  // Only the DOM and the first-paint hint follow the state; nothing is set back from here.
  useEffect(() => apply(density), [density]);

  const setDensity = useCallback(
    (next: Density) => {
      write(userKey(userId), next);
      setChosen(next);
    },
    [userId],
  );
  const toggle = useCallback(
    () => setDensity(density === 'compact' ? 'comfortable' : 'compact'),
    [density, setDensity],
  );

  return (
    <DensityContext.Provider value={{ density, setDensity, toggle }}>
      {children}
    </DensityContext.Provider>
  );
}

export function useDensity(): DensityControl {
  const value = useContext(DensityContext);
  if (!value) throw new Error('useDensity outside DensityProvider');
  return value;
}
