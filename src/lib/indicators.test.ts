import { describe, expect, it } from 'vitest';
import {
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
  calculateSMA,
  calculateStandardDeviation,
} from './indicators';

describe('technical indicators', () => {
  it('returns stable defaults for insufficient data', () => {
    expect(calculateRSI([1, 2, 3], 14)).toBe(50);
    expect(calculateSMA([], 20)).toBe(0);
    expect(calculateStandardDeviation([1, 2, 3], 20)).toBe(0);
    expect(calculateMACD([1, 2, 3])).toEqual({ macd: 0, signal: 0, histogram: 0 });
  });

  it('calculates SMA from the most recent period', () => {
    expect(calculateSMA([1, 2, 3, 4, 5], 3)).toBe(4);
  });

  it('calculates standard deviation and Bollinger bands', () => {
    const prices = [1, 2, 3, 4, 5];
    expect(calculateStandardDeviation(prices, 5)).toBeCloseTo(Math.sqrt(2), 8);

    const bands = calculateBollingerBands(prices, 5, 2);
    expect(bands.middle).toBe(3);
    expect(bands.upper).toBeCloseTo(3 + Math.sqrt(2) * 2, 8);
    expect(bands.lower).toBeCloseTo(3 - Math.sqrt(2) * 2, 8);
  });

  it('returns high RSI for a sustained uptrend', () => {
    const prices = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(calculateRSI(prices)).toBe(100);
  });

  it('calculates MACD from full EMA series instead of matching only final EMAs', () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 + i * 1.5 + Math.sin(i / 4) * 2);
    const macd = calculateMACD(prices);

    expect(macd.macd).not.toBe(0);
    expect(macd.signal).not.toBe(0);
    expect(macd.histogram).toBeCloseTo(macd.macd - macd.signal, 10);
    expect(Math.abs(macd.histogram)).toBeGreaterThan(0.0001);
  });
});
