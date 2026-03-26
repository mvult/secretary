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

export function getCurrentJournalDate(now = new Date()) {
  const journalDate = new Date(now);
  if (journalDate.getHours() >= 20) {
    journalDate.setDate(journalDate.getDate() + 1);
  }
  return journalDate;
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
