'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatServer } = require('../server');

function createSseReader(reader) {
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async waitForEvent(eventName, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const completeEventEnd = buffer.indexOf('\n\n');
        if (completeEventEnd !== -1) {
          const rawEvent = buffer.slice(0, completeEventEnd);
          buffer = buffer.slice(completeEventEnd + 2);
          const event = /^event: (.+)$/m.exec(rawEvent)?.[1];
          const data = /^data: (.+)$/m.exec(rawEvent)?.[1];
          if (event === eventName && data) return JSON.parse(data);
          continue;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), remaining);
          })
        ]);
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
      }
      throw new Error(`Timed out waiting for SSE event: ${eventName}`);
    }
  };
}

test('chat API serves config, accepts messages and streams them', async (t) => {
  const server = createChatServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const abortController = new AbortController();

  t.after(async () => {
    abortController.abort();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);

  const configResponse = await fetch(`${baseUrl}/api/config`);
  const config = await configResponse.json();
  assert.ok(config.rooms.some((room) => room.id === 'lobby'));
  assert.equal(config.limits.message, 500);

  const eventsResponse = await fetch(
    `${baseUrl}/api/events?room=lobby&name=${encodeURIComponent('测试用户')}&cid=test-client-001`,
    { signal: abortController.signal }
  );
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get('content-type'), /text\/event-stream/);

  const sse = createSseReader(eventsResponse.body.getReader());
  const ready = await sse.waitForEvent('ready');
  assert.equal(ready.room, 'lobby');
  assert.ok(ready.online >= 1);

  const clientId = 'test-client-001';
  const postResponse = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: 'lobby',
      name: '测试用户',
      clientId,
      text: '你好，回声！'
    })
  });
  assert.equal(postResponse.status, 201);
  const posted = await postResponse.json();
  assert.equal(posted.message.text, '你好，回声！');

  const streamedMessage = await sse.waitForEvent('message');
  assert.equal(streamedMessage.id, posted.message.id);
  assert.equal(streamedMessage.clientId, clientId);

  const historyResponse = await fetch(`${baseUrl}/api/history?room=lobby`);
  const history = await historyResponse.json();
  assert.ok(history.messages.some((message) => message.id === posted.message.id));
});

test('chat API rejects invalid rooms and blank messages', async (t) => {
  const server = createChatServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const invalidRoom = await fetch(`${baseUrl}/api/history?room=unknown`);
  assert.equal(invalidRoom.status, 400);

  const blankMessage = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: 'lobby',
      name: '测试用户',
      clientId: 'test-client-002',
      text: '   '
    })
  });
  assert.equal(blankMessage.status, 400);

  const formPost = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      room: 'lobby',
      name: '测试用户',
      clientId: 'test-client-003',
      text: '跨站请求'
    })
  });
  assert.equal(formPost.status, 415);

  const crossSitePost = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://not-this-site.example'
    },
    body: JSON.stringify({
      room: 'lobby',
      name: '测试用户',
      clientId: 'test-client-004',
      text: '跨站请求'
    })
  });
  assert.equal(crossSitePost.status, 403);
});
