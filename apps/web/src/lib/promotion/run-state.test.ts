import { describe, expect, it } from 'vitest';
import { runEditable } from './run-state';

describe('runEditable (the run page)', () => {
  it('a draft or applied run is editable; one being applied is not', () => {
    expect(runEditable({ status: 'DRAFT', lastError: null })).toBe(true);
    expect(runEditable({ status: 'APPLIED', lastError: null })).toBe(true);
    expect(runEditable({ status: 'APPLYING', lastError: null })).toBe(false);
  });

  it('a run the job stopped (APPLYING with an error) can be fixed: editable (review round 2, SF-1)', () => {
    expect(runEditable({ status: 'APPLYING', lastError: 'SECTION_FULL' })).toBe(true);
  });
});
