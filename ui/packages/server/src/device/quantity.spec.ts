import { describe, it, expect } from 'vitest';
import { parseQuantity } from './quantity';

describe('parseQuantity', () => {
  it.each([
    ['123456789n', 0.123456789],
    ['250m', 0.25],
    ['2', 2],
    ['1500u', 0.0015],
    ['1024Ki', 1048576],
    ['512Mi', 536870912],
    ['16Gi', 17179869184],
    ['1G', 1e9],
  ])('parseQuantity(%s) = %d', (q, n) =>
    expect(parseQuantity(q)).toBeCloseTo(n, 9),
  );
  it('throws on garbage', () => expect(() => parseQuantity('lots')).toThrow());
});
