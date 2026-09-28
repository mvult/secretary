import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftScope } from '../src/lib/draftStorage';
import { prepareTodoCommand, sendTodoCommand } from '../src/features/session/todoCommandController';

test('retained commands reject scope mismatches before transport and mismatched acknowledgments afterward', async () => {
  const scope = draftScope('https://example.com', 1, 1);
  const envelope = prepareTodoCommand(scope, 'repository', 7);
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json({ mutationId: crypto.randomUUID(), effects: {} }); }) as typeof fetch;
  try {
    await assert.rejects(sendTodoCommand(scope[0], 'token', draftScope(scope[0], 2, 1), envelope), /scope/);
    assert.equal(sends, 0);
    await assert.rejects(sendTodoCommand(scope[0], 'token', scope, envelope), /acknowledgment/);
    assert.equal(sends, 1);
    for (const date of ['2026-02-30', '0000-01-01', '2026-9-26', 'not a date']) {
      assert.throws(() => prepareTodoCommand(scope, 'pull', date), /date/);
    }
  } finally { globalThis.fetch = original; }
});
