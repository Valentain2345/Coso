import { describe, expect, it } from 'vitest';
import { parseClock } from '../src/lib/export/formats';

describe('parseClock', () => {
  it('parses m:ss and h:mm:ss clocks into seconds', () => {
    expect(parseClock('1:24')).toBe(84);
    expect(parseClock('0:05')).toBe(5);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('75:30')).toBe(4530); // long m:ss is allowed
  });

  it('ignores the brackets shown by the player', () => {
    expect(parseClock('[1:24]')).toBe(84);
    expect(parseClock('(0:05)')).toBe(5);
  });

  it('accepts fractional seconds with dot or comma', () => {
    expect(parseClock('1:02.5')).toBeCloseTo(62.5);
    expect(parseClock('1:02,25')).toBeCloseTo(62.25);
  });

  it('rejects garbage and impossible clocks', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock('1:24 extra')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('1:75')).toBeNull(); // seconds over 59
    expect(parseClock('1:62:03')).toBeNull(); // minutes over 59 in h:mm:ss
    expect(parseClock('::')).toBeNull();
    expect(parseClock('84')).toBeNull(); // no separator: never guess
  });

  it('never invents a value from whitespace', () => {
    expect(parseClock('  1:02  ')).toBe(62);
    expect(parseClock('   ')).toBeNull();
  });
});
