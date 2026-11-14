/**
 * The API's configured address: NEXT_PUBLIC_API_URL, inlined at build time (into the browser code
 * and the server's alike). AuthClient (lib/auth/auth-client.ts) and the boot refresh script
 * (lib/auth/boot-refresh.ts) both start from it.
 */
export const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
