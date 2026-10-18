'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the whole document,
 * so it has no app styles, fonts or translations: inline styles, both languages.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[jantrik] root layout error', error);
  }, [error]);
  const button = {
    minHeight: 44,
    padding: '0 18px',
    borderRadius: 10,
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  } as const;
  return (
    <html lang="bn">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f4f7f6',
          color: '#15231f',
          font: '16px/1.7 system-ui, sans-serif',
        }}
      >
        <main
          role="alert"
          data-testid="global-error"
          style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}
        >
          <title>যন্ত্রিক স্কুল</title>
          <h1 style={{ fontSize: 24, margin: '0 0 8px' }}>কিছু একটা সমস্যা হয়েছে</h1>
          <p style={{ margin: '0 0 4px' }}>
            পাতাটি আবার লোড করুন। এই ফোনে রাখা হাজিরা মুছে যায়নি।
          </p>
          <p lang="en" style={{ margin: '0 0 20px', color: '#5a6b66' }}>
            Something went wrong. Reload the page; attendance kept on this phone is not lost.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={reset}
              style={{ ...button, border: 0, background: '#0e5e50', color: '#fff' }}
            >
              আবার চেষ্টা করুন
            </button>
            <button
              type="button"
              onClick={() => location.reload()}
              style={{
                ...button,
                border: '1px solid #cfdad6',
                background: '#fff',
                color: '#15231f',
              }}
            >
              পাতা আবার লোড করুন
            </button>
          </div>
          {error.digest && (
            <p style={{ marginTop: 16, fontSize: 12, color: '#5a6b66' }}>
              ত্রুটির কোড: {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
