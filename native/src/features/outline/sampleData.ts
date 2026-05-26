import type { OutlinePage } from './types';

export function formatPageDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function getDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

export function getAvailableJournalDates(now = new Date()) {
  if (now.getDay() === 5 && now.getHours() >= 18) {
    return [1, 2, 3].map((days) => shiftDate(now, days));
  }
  if (now.getHours() >= 18) {
    return [shiftDate(now, 1)];
  }
  return [new Date(now)];
}

export function getCurrentJournalDate(now = new Date()) {
  return getAvailableJournalDates(now)[0] ?? new Date(now);
}

export function createJournalPage(date = getCurrentJournalDate()): OutlinePage {
  const dateKey = getDateKey(date);

  return {
    id: `journal-${crypto.randomUUID()}`,
    kind: 'journal',
    date: dateKey,
    title: dateKey,
    nodes: [
      {
        id: `node-${crypto.randomUUID()}`,
        parentId: null,
        text: '',
        todoStatus: null,
      },
    ],
  };
}
