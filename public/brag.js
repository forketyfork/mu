// Pure helpers of the brag view. The storage format is described in "Brag doc" in docs/architecture.md: a day,
// week or month page is one Markdown file, and a week or month page exists only when a dream wrote it.

const byKeyDescending = (a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

// Returns {day, week, month}: the pages of each scale, newest first. Empty files are not pages.
export function groupBrag({ days = [], weeks = [], months = [] }) {
  const pages = (files) => files.filter(({ source }) => source.trim()).sort(byKeyDescending);
  return { day: pages(days), week: pages(weeks), month: pages(months) };
}

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function periodLabel(scale, key) {
  if (scale === 'month') return `${monthNames[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
  if (scale === 'week') return `Week ${Number(key.slice(6))}, ${key.slice(0, 4)}`;
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const emptyMessages = {
  day: 'No days recorded yet. A dream writes one page per day.',
  week: 'No weekly summaries yet. A dream writes one when the week is over.',
  month: 'No monthly summaries yet. A dream writes one when the month is over.',
};
