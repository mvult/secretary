import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAPI, rpcJson } from '../src/client';
import { BackendError, postJsonBody } from '../src/transport';
import { safeInteger, decimalRevision } from '../src/identity';
import { PersistenceError, PersistenceErrorReason } from '../src/gen/secretary/v1/persistence_pb';

test('retained transport preserves exact bytes, token and cancellation', async () => {
  const bytes = '{ "id":"7", "patch":{"desc":""}, "mutationId":"original" }';
  const controller = new AbortController();
  await postJsonBody('https://example.test/', '/rpc', bytes, { token: 'original-token', signal: controller.signal,
    fetch: (async (url, init) => {
      assert.equal(url, 'https://example.test/rpc');
      assert.equal(init?.body, bytes);
      assert.equal(init?.signal, controller.signal);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer original-token');
      return Response.json({});
    }) as typeof fetch });
});

test('typed persistence errors and auth scope survive transport', async () => {
  const detail = new PersistenceError({ reason: PersistenceErrorReason.PROTOCOL_UPGRADE_REQUIRED });
  const wire = { type: PersistenceError.typeName, value: btoa(String.fromCharCode(...detail.toBinary())) };
  const failures: unknown[] = [];
  await assert.rejects(postJsonBody('https://example.test', '/rpc', '{}', { token: 'expired', onAuthFailure: failure => failures.push(failure),
    fetch: (async () => Response.json({ code: 'unauthenticated', message: 'expired', details: [wire] }, { status: 401 })) as typeof fetch }),
    (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, 'unauthenticated');
      assert.deepEqual(error.details, [wire]);
      assert.equal(error.persistenceDetails()[0].reason, PersistenceErrorReason.PROTOCOL_UPGRADE_REQUIRED);
      return true;
    });
  assert.deepEqual(failures, [{ baseUrl: 'https://example.test', token: 'expired' }]);
});

test('generated native adapter preserves revisions and explicit patch presence', async () => {
  const result = await rpcJson<{ directory: { id: string } }>('https://example.test', '/secretary.v1.DocumentsService/UpdateDirectory',
    { id: 4, patch: { parentId: 0 } }, { fetch: (async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { id: '4', patch: { parentId: '0' } });
      return Response.json({ directory: { id: '4' } });
    }) as typeof fetch });
  assert.equal(result.directory.id, '4');
  const doc = await rpcJson<{ document: { revision: string } }>('https://example.test', '/secretary.v1.DocumentsService/GetDocument', { id: 4 }, {
    fetch: (async () => Response.json({ document: { id: '4', revision: '9223372036854775807' } })) as typeof fetch,
  });
  assert.equal(doc.document.revision, '9223372036854775807');
  assert.equal(decimalRevision(doc.document.revision), doc.document.revision);
  assert.throws(() => safeInteger(doc.document.revision), /safe range/);
  assert.equal(safeInteger('2147483647'), 2147483647);
});

test('generated clients use current token and expose the same typed error contract', async () => {
  let token = 'first';
  const tokens: string[] = [];
  const failures: unknown[] = [];
  const api = createAPI({ baseUrl: 'https://example.test', getToken: () => token, onAuthFailure: failure => failures.push(failure),
    fetch: (async (_url, init) => {
      tokens.push(new Headers(init?.headers).get('Authorization')!);
      return Response.json({ code: 'unauthenticated', message: 'expired' }, { status: 401 });
    }) as typeof fetch });
  for (const next of ['first', 'second']) {
    token = next;
    await assert.rejects(api.todos.listTodos({ userId: 1n }), (err: unknown) => err instanceof BackendError && err.code === 'unauthenticated');
  }
  assert.deepEqual(tokens, ['Bearer first', 'Bearer second']);
  assert.deepEqual(failures, [{ baseUrl: 'https://example.test', token: 'first' }, { baseUrl: 'https://example.test', token: 'second' }]);
});
