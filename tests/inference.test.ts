import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CONFIG } from '../backend/config';
import { computeFileSha256, ensureModelReady, getPublicModelStatus } from '../backend/model/loader';
import { runCompletion, stopGeneration, streamGeneration } from '../backend/inference/engine';
import { handleApiRequest } from '../backend/router';

test('model readiness verifies exact GGUF SHA-256 and byte size', async () => {
  const assets = await ensureModelReady();
  assert.equal(assets.sizeBytes, MODEL_CONFIG.expectedBytes);
  const actualSha = await computeFileSha256(assets.modelPath);
  assert.equal(actualSha, MODEL_CONFIG.sha256);

  const status = getPublicModelStatus();
  assert.equal(status.status, 'ready');
  assert.equal(status.label, 'Ready');
  assert.equal(status.ready, true);
});

test('real Falcon-H1 inference generates a valid response', async () => {
  const result = await runCompletion({
    requestId: 'test_inf_1',
    messages: [{ role: 'user', content: 'What is 2 + 2? Answer in one short sentence.' }],
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 48,
  });

  assert.ok(result.content.length > 0, 'Expected non-empty model output');
  assert.equal(result.content.includes('[end of text]'), false);
  assert.equal(result.content.includes('<|im_end|>'), false);

  const identityResult = await runCompletion({
    requestId: 'test_inf_identity',
    messages: [{ role: 'user', content: 'whats your name' }],
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 48,
  });
  assert.ok(
    identityResult.content.startsWith('I am WebGPT made by Abdus Nilom'),
    `Expected identity response, got: ${identityResult.content}`
  );
});

test('streaming generation supports live tokens and stop cancellation', async () => {
  const reqId = 'test_stop_1';
  let tokens = '';

  const promise = streamGeneration(
    {
      requestId: reqId,
      messages: [{ role: 'user', content: 'Count from 1 to 100 slowly and explain each number.' }],
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 256,
    },
    {
      onToken: (tok) => {
        tokens += tok;
        if (tokens.length >= 12) {
          stopGeneration(reqId);
        }
      },
    }
  );

  const res = await promise;
  assert.ok(tokens.length > 0, 'Expected streamed tokens before stop');
  assert.equal(res.finishReason, 'aborted');
});

test('HTTP router endpoints /api/health, /api/model/status, /api/chat, /api/chat/stream, /api/chat/stop work', async () => {
  const healthRes = await handleApiRequest(new Request('http://localhost:3000/api/health'));
  assert.equal(healthRes.status, 200);
  const healthJson = (await healthRes.json()) as { ok: boolean; name: string; creator: string };
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.name, 'WebGPT');
  assert.equal(healthJson.creator, 'Abdus Nilom');

  const statusRes = await handleApiRequest(
    new Request('http://localhost:3000/api/model/status')
  );
  assert.equal(statusRes.status, 200);
  const statusJson = (await statusRes.json()) as { label: string; ready: boolean };
  assert.equal(statusJson.label, 'Ready');
  assert.equal(statusJson.ready, true);

  const streamRes = await handleApiRequest(
    new Request('http://localhost:3000/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'test_sse_1',
        messages: [{ role: 'user', content: 'Say hello in five words.' }],
        maxTokens: 32,
      }),
    })
  );
  assert.equal(streamRes.status, 200);
  assert.ok(streamRes.headers.get('content-type')?.includes('text/event-stream'));
  const sseBody = await streamRes.text();
  assert.ok(sseBody.includes('event: start'));
  assert.ok(sseBody.includes('event: token'));
  assert.ok(sseBody.includes('event: done'));

  const stopRes = await handleApiRequest(
    new Request('http://localhost:3000/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'test_sse_1' }),
    })
  );
  assert.equal(stopRes.status, 200);
});
