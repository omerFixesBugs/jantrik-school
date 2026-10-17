/** Redis key marking a session as revoked; checked by JwtAuthGuard on every request. */
export const revokedSessionKey = (sessionId: string) => `revoked:sid:${sessionId}`;
