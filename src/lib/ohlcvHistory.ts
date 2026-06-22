export type OhlcvRow = [number, number, number, number, number, number, ...unknown[]];

export function timeframeToMilliseconds(timeframe: string) {
  const normalized = String(timeframe || "1h").trim().toLowerCase();
  const value = Number(normalized.slice(0, -1));
  if (!Number.isFinite(value) || value <= 0) return 60 * 60 * 1000;
  if (normalized.endsWith("m")) return value * 60 * 1000;
  if (normalized.endsWith("h")) return value * 60 * 60 * 1000;
  if (normalized.endsWith("d")) return value * 24 * 60 * 60 * 1000;
  if (normalized.endsWith("w")) return value * 7 * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

export function calculateOhlcvStartSince({
  timeframe,
  limit,
  now = Date.now(),
  paddingBars = 20,
}: {
  timeframe: string;
  limit: number;
  now?: number;
  paddingBars?: number;
}) {
  const frameMs = timeframeToMilliseconds(timeframe);
  const normalizedLimit = Math.max(1, Math.floor(Number(limit) || 1));
  return Math.max(0, now - (normalizedLimit + Math.max(0, paddingBars)) * frameMs);
}

export function nextOhlcvSince(batch: unknown[], previousSince: number) {
  const timestamps = batch
    .map((row: any) => Number(Array.isArray(row) ? row[0] : NaN))
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  const next = Math.max(...timestamps) + 1;
  return next > previousSince ? next : null;
}

export function normalizeOhlcvHistory(batches: unknown[][], limit: number) {
  const byTimestamp = new Map<number, OhlcvRow>();
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const row of batch) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const timestamp = Number(row[0]);
      if (!Number.isFinite(timestamp)) continue;
      byTimestamp.set(timestamp, row as OhlcvRow);
    }
  }

  const sorted = Array.from(byTimestamp.values()).sort((a, b) => Number(a[0]) - Number(b[0]));
  const normalizedLimit = Math.max(1, Math.floor(Number(limit) || sorted.length || 1));
  return sorted.slice(-normalizedLimit);
}
