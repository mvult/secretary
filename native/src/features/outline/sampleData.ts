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
  return date.toISOString().slice(0, 10);
}

export function createJournalPage(date = new Date()): OutlinePage {
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
        status: 'note',
      },
    ],
  };
}
