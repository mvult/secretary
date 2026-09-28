import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Todo, TodoStatus, UpdateTodoRequest, UpdateTodoResponse, CreateTodoRequest, CreateTodoResponse, DeleteTodoRequest, DeleteTodoResponse } from '@secretary/api/gen/todos_pb';
import { retainedTodoCommand, todoEditPatch, MissingTodoCommandTarget, type RetainedUpdateIO, type TodoCommand } from '../src/lib/retainedTodoCommand';

const retainedTodoUpdate = (io: RetainedUpdateIO, request?: UpdateTodoRequest) => retainedTodoCommand(io, request ? { operation: 'update', request } : undefined);

function fixture() {
  const data = new Map<string, string>();
  const request = new UpdateTodoRequest({ id: 7n, workspaceId: 3n, protocolVersion: 1,
    mutationId: 'fd1c00b9-1df5-4e2b-8539-26daa8ca5243', patch: { desc: '' } });
  const sent: string[] = [];
  const io: RetainedUpdateIO = {
    key: 'backend:actor', storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } },
    checkScope: () => {}, refresh: async () => {},
    send: async bytes => {
      assert.equal(JSON.parse(data.get(io.key)!).bytes, bytes, 'transport preceded retention');
      sent.push(bytes);
      return new UpdateTodoResponse({ mutationId: request.mutationId, todo: { id: 7n }, effects: {} });
    },
  };
  return { io, request, data, sent };
}

test('editing status omits unchanged metadata and explicit clears retain presence', () => {
  const todo = new Todo({ name: 'Original', desc: 'Description', status: TodoStatus.TODO });
  const patch = todoEditPatch(todo, { name: 'Original', desc: '', status: TodoStatus.DONE });
  assert.equal(patch.name, undefined);
  assert.equal(patch.desc, '');
  assert.equal(patch.status, TodoStatus.DONE);
});

test('lost response replays exact persisted bytes after restart, without substituting newer edits', async () => {
  const { io, request, data, sent } = fixture();
  const send = io.send;
  io.send = async (bytes, operation) => { await send(bytes, operation); throw new Error('lost response'); };
  await assert.rejects(retainedTodoUpdate(io, request), /lost response/);
  const retained = JSON.parse(data.get(io.key)!).bytes;
  request.patch!.desc = 'new intent';
  await assert.rejects(retainedTodoUpdate(io, request), /Recover/);
  io.send = send;
  await retainedTodoUpdate({ ...io });
  assert.deepEqual(sent, [retained, retained]);
  assert.equal(data.size, 0);
});

test('refresh failure and malformed acknowledgment retain the original request', async () => {
  const { io, request, data } = fixture();
  io.refresh = async () => { throw new Error('refresh failed'); };
  await assert.rejects(retainedTodoUpdate(io, request), /refresh failed/);
  const original = data.get(io.key);
  io.send = async () => new UpdateTodoResponse({ todo: { id: 7n } });
  await assert.rejects(retainedTodoUpdate(io), /Invalid TODO acknowledgment/);
  assert.equal(data.get(io.key), original);
});

test('scope change after transport prevents cache reconciliation and receipt release', async () => {
  const { io, request, data } = fixture();
  const send = io.send;
  io.send = async (bytes, operation) => {
    const result = await send(bytes, operation);
    io.checkScope = () => { throw new Error('scope changed'); };
    return result;
  };
  io.refresh = async () => { assert.fail('refreshed new account'); };
  await assert.rejects(retainedTodoUpdate(io, request), /scope changed/);
  assert.equal(data.size, 1);
});

test('storage failure prevents transport', async () => {
  const { io, request, sent } = fixture();
  io.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(retainedTodoUpdate(io, request), /quota/);
  assert.equal(sent.length, 0);
});

for (const operation of ['create', 'delete'] as const) test(`${operation} replays the same operation and bytes after failed live refresh`, async () => {
  const { io, request, data } = fixture();
  const command: TodoCommand = operation === 'create'
    ? { operation, request: new CreateTodoRequest({ name: 'New', userId: 1n, protocolVersion: 1, mutationId: request.mutationId }) }
    : { operation, request: new DeleteTodoRequest({ id: 7n, workspaceId: 3n, protocolVersion: 1, mutationId: request.mutationId }) };
  const sent: string[] = [];
  io.send = async (bytes, rpc) => {
    assert.equal(rpc, operation);
    sent.push(bytes);
    return operation === 'create'
      ? new CreateTodoResponse({ mutationId: request.mutationId, todo: { id: 8n }, effects: {} })
      : new DeleteTodoResponse({ mutationId: request.mutationId, effects: {} });
  };
  io.refresh = async () => { throw new Error('offline'); };
  await assert.rejects(retainedTodoCommand(io, command), /offline/);
  assert.equal(data.size, 1);
  io.refresh = async () => {};
  await retainedTodoCommand(io);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(data.size, 0);
});

test('missing target releases a rejected request only after live refresh', async () => {
  const { io, request, data } = fixture();
  io.send = async () => { throw new MissingTodoCommandTarget('gone'); };
  io.refresh = async () => { throw new Error('offline'); };
  await assert.rejects(retainedTodoUpdate(io, request), /offline/);
  assert.equal(data.size, 1);
  io.refresh = async () => {};
  await assert.rejects(retainedTodoUpdate(io), /gone/);
  assert.equal(data.size, 0);
});
