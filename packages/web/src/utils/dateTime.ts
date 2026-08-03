export function parseServerDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const normalized = typeof value === 'string' && !/[zZ]|[+-]\d{2}(?::?\d{2})?$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getTimestamp(value: string | number | Date | null | undefined): number {
  return parseServerDate(value)?.getTime() ?? 0;
}

export function formatServerDateTime(value: string | number | Date | null | undefined): string {
  const date = parseServerDate(value);
  if (!date) return '-';
  return date.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  now = Date.now()
): string {
  const timestamp = getTimestamp(value);
  if (!timestamp) return 'Unknown';

  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return 'just now';

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return parseServerDate(value)?.toLocaleDateString() ?? 'Unknown';
}
