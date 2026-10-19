import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv.js';

describe('csvCell', () => {
  it('neutralises formulas', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell('+8801711000001')).toBe("'+8801711000001");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
  });

  it('quotes commas, quotes and newlines; leaves plain text', () => {
    expect(csvCell('তাসনিম রহমান')).toBe('তাসনিম রহমান');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('toCsv adds a BOM and CRLF', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['=1', 'c'],
      ]),
    ).toBe("﻿a,b\r\n'=1,c\r\n");
  });
});
