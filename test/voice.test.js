import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-voice-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
const chat = await import('../server/chat.js');

// a fake provider with speech endpoints; it records what it receives
const seen = [];
const provider = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ url: req.url, type: req.headers['content-type'], auth: req.headers.authorization, body });
    if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: '  What is due today? ' }));
    if (req.url === '/v1/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
after(() => (provider.close(), store.db.close(), rmSync(tmp, { recursive: true, force: true })));

test('voice models are optional settings', () => {
  const s = store.updateLlmSettings({ baseUrl, apiKey: 'sk-voice', model: 'chat-model' });
  assert.equal(s.sttModel, '');
  assert.equal(s.ttsModel, '');
  const v = store.updateLlmSettings({ sttModel: ' whisper-1 ', ttsModel: 'tts-1', ttsVoice: 'nova' });
  assert.deepEqual([v.sttModel, v.ttsModel, v.ttsVoice], ['whisper-1', 'tts-1', 'nova']);
});

test('transcribe sends the recording as a multipart file and returns trimmed text', async () => {
  const audio = Buffer.from('fake-webm-bytes');
  const { text } = await chat.transcribe(audio, 'audio/webm;codecs=opus');
  assert.equal(text, 'What is due today?');
  const req = seen.at(-1);
  assert.equal(req.url, '/v1/audio/transcriptions');
  assert.equal(req.auth, 'Bearer sk-voice');
  assert.match(req.type, /^multipart\/form-data/);
  const body = req.body.toString();
  assert.match(body, /name="model"\r\n\r\nwhisper-1/);
  assert.match(body, /filename="speech\.webm"/);
  assert.ok(body.includes('fake-webm-bytes'));
  await assert.rejects(chat.transcribe(Buffer.alloc(0)), (err) => err.kind === 'empty_audio');
});

test('speak returns audio from the provider', async () => {
  const { audio, contentType } = await chat.speak('Hello there');
  assert.equal(contentType, 'audio/mpeg');
  assert.deepEqual([...audio], [0xff, 0xfb, 0x90, 0x00]);
  const sent = JSON.parse(seen.at(-1).body.toString());
  assert.deepEqual(sent, { model: 'tts-1', input: 'Hello there', voice: 'nova', response_format: 'mp3' });
  await assert.rejects(chat.speak('   '), (err) => err.kind === 'empty_text');
});

test('without voice models, the errors say what to do', async () => {
  store.updateLlmSettings({ sttModel: '', ttsModel: '' });
  await assert.rejects(chat.transcribe(Buffer.from('x')), (err) => err.kind === 'no_voice' && /browser’s/.test(err.message));
  await assert.rejects(chat.speak('hi'), (err) => err.kind === 'no_voice');
});
