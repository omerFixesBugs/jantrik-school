/**
 * What the run page lets the admin do with a promotion run.
 * `editable`: rows may be changed, refreshed, and (with nothing applied) the run deleted. A run
 * being applied is not, except one its job stopped (`lastError` set, review round 2 SF-1): that
 * one is fixed here, then resumed. The API still answers 409 while a retry is queued.
 */
export function runEditable(run: { status: string; lastError: string | null }): boolean {
  return run.status !== 'APPLYING' || run.lastError !== null;
}
