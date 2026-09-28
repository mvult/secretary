/** Explicit app boundary: wire int64s stay bigint/decimal until this check. */
export function safeInteger(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') throw new Error('Invalid integer.');
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error('Invalid integer.');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Integer exceeds the application safe range.');
  return number;
}

export function decimalRevision(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe document revision.');
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > 9223372036854775807n) throw new Error('Invalid document revision.');
  return text;
}
