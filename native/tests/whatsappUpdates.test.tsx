import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useWhatsAppUpdateNotification } from '../src/features/settings/useWhatsAppUpdateNotification';

test('WhatsApp update alerts deduplicate across remounts and retry after permission is granted', async () => {
  const keys = ['window', 'localStorage', 'Notification', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const saved = new Map<string, string>();
  const notifications: string[] = [];
  let latest = 'new-version';
  let poll!: () => void;
  class NotificationMock {
    static permission = 'granted';
    constructor(_title: string, options: { body: string }) { notifications.push(options.body); }
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    Notification: NotificationMock,
    window: { Notification: NotificationMock, setInterval: (fn: () => void) => { poll = fn; return 1; }, clearInterval: () => {} },
    localStorage: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) },
    fetch: async () => new Response(JSON.stringify({ enabled: true, status: { library_update: { current: 'old-version', latest, available: true } } })),
  });
  function Harness() { useWhatsAppUpdateNotification('https://backend.test', 'token'); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); });
    assert.equal(notifications.length, 1);
    await act(async () => renderer.unmount());
    await act(async () => { renderer = create(createElement(Harness)); });
    assert.equal(notifications.length, 1);
    latest = 'newer-version';
    NotificationMock.permission = 'denied';
    await act(async () => poll());
    assert.equal(notifications.length, 1);
    NotificationMock.permission = 'granted';
    await act(async () => poll());
    assert.equal(notifications.length, 2);
    await act(async () => poll());
    assert.equal(notifications.length, 2);
  } finally {
    await act(async () => renderer?.unmount());
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
