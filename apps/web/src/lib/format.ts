/** Display helpers shared by components. */

export function initials(name: string | undefined): string {
  const trimmed = name?.trim() ?? '';
  return trimmed ? Array.from(trimmed)[0]?.toUpperCase() ?? '?' : '?';
}

/** Cursor and avatar colours that stay readable on the paper background. */
const PALETTE = ['#b5462f', '#2f6f9f', '#3d7a52', '#8a5aa6', '#b07a1f', '#2f8a85', '#a8486f', '#5f6b2f'];

export function colorFor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0] ?? '#b5462f';
}

const RELATIVE = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 45) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return RELATIVE.format(days, 'day');
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function fullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

export function excerpt(text: string, length = 80): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
