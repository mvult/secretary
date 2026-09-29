import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useJournalPreviews } from '../src/features/journals/useJournalPreviews';
import type { OutlinePage } from '../src/features/outline/types';

test('journal previews load only nearby cards, two at a time, and stay idle offline', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const original = globalThis.IntersectionObserver;
  const observers = new Set<{ emit: () => void }>();
  class Observer {
    nodes: { dataset: { journalId: string } }[] = [];
    constructor(private callback: (entries: unknown[]) => void) { observers.add(this); }
    observe(node: { dataset: { journalId: string } }) { this.nodes.push(node); }
    disconnect() { observers.delete(this); }
    emit() { this.callback(this.nodes.map(target => ({ target, isIntersecting: target.dataset.journalId !== 'far' }))); }
  }
  globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
  let pages: OutlinePage[] = ['one', 'two', 'three', 'far'].map(id => ({ id, kind: 'journal', date: '2026-09-28', title: id, nodes: [], metadataOnly: true }));
  const calls: string[] = [];
  const finish = new Map<string, () => void>();
  let install!: (update: (pages: OutlinePage[]) => OutlinePage[]) => void;
  const load = async (id: string) => {
    calls.push(id);
    await new Promise<void>(resolve => finish.set(id, resolve));
    const page = { ...pages.find(page => page.id === id)!, metadataOnly: undefined };
    install(current => current.map(entry => entry.id === id ? page : entry));
    return page;
  };
  function Harness({ online }: { online: boolean }) {
    const [journals, setJournals] = useState(pages);
    pages = journals; install = setJournals;
    const { stackRef } = useJournalPreviews(journals, online, load);
    return createElement('div', { ref: stackRef });
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness, { online: false }), { createNodeMock: () => ({
      querySelectorAll: () => pages.filter(page => page.metadataOnly).map(page => ({ dataset: { journalId: page.id } })),
    }) }); });
    assert.equal(observers.size, 0);
    assert.deepEqual(calls, []);
    await act(async () => renderer.update(createElement(Harness, { online: true })));
    await act(async () => { for (const observer of observers) observer.emit(); });
    assert.deepEqual(calls, ['one', 'two']);
    await act(async () => finish.get('one')!());
    await act(async () => { for (const observer of observers) observer.emit(); });
    assert.deepEqual(calls, ['one', 'two', 'three']);
    await act(async () => { finish.get('two')!(); finish.get('three')!(); });
    assert.equal(calls.includes('far'), false);
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.IntersectionObserver = original;
  }
});
