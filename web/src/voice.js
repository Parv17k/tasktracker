// Voice for the chat: listen (speech to text) and speak (text to speech).
// Uses the AI provider's audio models when they're set in settings, otherwise the
// browser's built-in speech features. Errors are plain sentences people can act on.

const SpeechRecognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export const canRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
export const hasBrowserListening = !!SpeechRecognition;
export const hasBrowserVoice = typeof window !== 'undefined' && 'speechSynthesis' in window;

const friendly = (message, kind) => Object.assign(new Error(message), { kind });

function micError(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError' || err === 'not-allowed' || err === 'service-not-allowed') {
    return friendly('Task Tracker can’t use your microphone. Allow microphone access for this site in your browser’s settings, then try again.', 'mic_blocked');
  }
  if (err?.name === 'NotFoundError' || err === 'audio-capture') return friendly('No microphone was found. Connect one and try again.', 'no_mic');
  if (err === 'network') return friendly('Your browser’s speech service isn’t reachable. Check your connection, or add a speech-to-text model in chat settings.', 'stt_network');
  if (err === 'no-speech') return friendly('I didn’t catch that. Tap the microphone and try again.', 'no_speech');
  return friendly('Voice input stopped unexpectedly. Try again.', 'voice_failed');
}

/**
 * Listen for one spoken message and return its text.
 * @param {{ useProvider: boolean, signal: AbortSignal, onLevel?: (n: number) => void, onInterim?: (text: string) => void }} opts
 */
export function listen({ useProvider, signal, onLevel, onInterim }) {
  if (useProvider && canRecord) return recordAndTranscribe({ signal, onLevel });
  if (hasBrowserListening) return browserListen({ signal, onInterim });
  if (canRecord) return Promise.reject(friendly('Voice input needs a speech-to-text model. Add one in chat settings.', 'no_voice'));
  return Promise.reject(friendly('This browser can’t take voice input.', 'unsupported'));
}

/** Record until the speaker goes quiet (or Stop is pressed), then transcribe on the server. */
async function recordAndTranscribe({ signal, onLevel }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw micError(err);
  }
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // stop after ~1.5 s of quiet once speech has started, or 6 s if nothing is said at all
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let heard = false;
  let quietSince = performance.now();
  const started = performance.now();
  let raf;

  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  const stop = () => recorder.state === 'recording' && recorder.stop();
  signal.addEventListener('abort', stop);

  const watch = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) ** 2;
    const level = Math.sqrt(sum / buf.length) / 128;
    onLevel?.(level);
    const now = performance.now();
    if (level > 0.04) ((heard = true), (quietSince = now));
    if ((heard && now - quietSince > 1500) || (!heard && now - started > 6000) || now - started > 60000) return stop();
    raf = requestAnimationFrame(watch);
  };
  recorder.start();
  watch();
  await stopped;
  cancelAnimationFrame(raf);
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  onLevel?.(0);

  if (signal.aborted && !heard) throw friendly('Stopped.', 'stopped');
  if (!heard) throw micError('no-speech');
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  let res;
  try {
    res = await fetch('/api/chat/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  } catch {
    throw friendly('Task Tracker’s server isn’t responding. Make sure it’s still running, then try again.', 'offline');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw friendly(data?.error || 'Couldn’t turn that recording into text. Try again.', data?.kind);
  if (!data.text) throw micError('no-speech');
  return data.text;
}

/** The browser's own speech recognition (shows words as you speak). */
function browserListen({ signal, onInterim }) {
  return new Promise((resolve, reject) => {
    const rec = new SpeechRecognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    let failed = null;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim?.((finalText + interim).trim());
    };
    rec.onerror = (e) => (failed = e.error);
    rec.onend = () => {
      signal.removeEventListener('abort', abort);
      const text = finalText.trim();
      if (text) resolve(text);
      else if (failed === 'aborted' || signal.aborted) reject(friendly('Stopped.', 'stopped'));
      else reject(micError(failed || 'no-speech'));
    };
    const abort = () => rec.stop();
    signal.addEventListener('abort', abort);
    try {
      rec.start();
    } catch (err) {
      reject(micError(err));
    }
  });
}

/** Markdown → something pleasant to hear. */
export function speakable(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, '$1$2')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, '')
    .replace(/#(\d+)\b/g, 'task $1')
    .replace(/[→]/g, ' to ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read text aloud. Resolves when finished (or stopped via `signal`).
 * @param {{ useProvider: boolean, signal: AbortSignal }} opts
 */
export async function speak(text, { useProvider, signal }) {
  if (!text) return;
  if (useProvider) {
    let res;
    try {
      res = await fetch('/api/chat/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal });
    } catch (err) {
      if (signal.aborted) return;
      throw friendly('Task Tracker’s server isn’t responding, so the answer can’t be read aloud.', 'offline');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw friendly(data?.error || 'The answer couldn’t be read aloud.', data?.kind);
    }
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    try {
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(friendly('The answer couldn’t be played. Check your sound output.', 'playback'));
        signal.addEventListener('abort', () => (audio.pause(), resolve()));
        audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    return;
  }
  if (!hasBrowserVoice) throw friendly('This browser can’t read answers aloud. Add a voice model in chat settings.', 'unsupported');
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || 'en-US';
    u.onend = resolve;
    u.onerror = resolve;
    signal.addEventListener('abort', () => (speechSynthesis.cancel(), resolve()));
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}
