/**
 * What the run page lets the admin do with a promotion run.
 * `editable`: rows may be changed, refreshed, and (with nothing applied) the run deleted.
 */
export function runEditable(run: { status: string; lastError: string | null }): boolean {
  return run.status !== 'APPLYING';
}
