import './ravi-microphone.css';
import { invoke } from '@tauri-apps/api/core';
import { lang } from './i18n';
import { createRaviDictation, type VoiceError, type VoiceState, type LocalRecognition } from './ravi-dictation';
import { voiceCopy } from './ravi-voice-copy';

// One controller and one DOM surface move with the existing small/large Ravi panel.
export function mountRaviMicrophone(api: { provider(): string; allowed(): boolean; transcript(text: string): void; quiet(): void; listening(on: boolean): void }) {
  const el = (id: string) => document.getElementById(id)!;
  const mic = el('rv-voice'), surface = el('ravi-voice-surface'), note = el('ravi-voice-note'), card = el('ravi-voice-consent');
  const settings = el('ravi-mic-settings'), canvas = el('ravi-voice-wave') as HTMLCanvasElement, elapsed = el('ravi-voice-time');
  const revoke = el('ravi-voice-revoke') as HTMLButtonElement, revokeNote = el('ravi-voice-revoked');
  function state(value: VoiceState, error?: VoiceError) {
    surface.hidden = value === 'idle'; card.hidden = value !== 'consent';
    canvas.hidden = elapsed.hidden = value !== 'listening';
    mic.setAttribute('aria-pressed', String(['requesting','listening','transcribing'].includes(value)));
    api.listening(value === 'listening');
    note.textContent = value === 'error' ? voiceCopy(error || 'response') : ['idle','consent'].includes(value) ? '' : voiceCopy(value as 'done');
    settings.hidden = !(value === 'error' && (error === 'denied' || error === 'permission') && /Mac/i.test(navigator.platform));
    settings.textContent = voiceCopy('settings');
    if (value === 'consent') {
      el('ravi-voice-disclosure').textContent = voiceCopy('consent');
      el('ravi-voice-provider').textContent = ({openai:'OpenAI',google:'Google Gemini',groq:'Groq'} as Record<string,string>)[api.provider()] || '';
      el('ravi-voice-agree').textContent = voiceCopy('agree'); el('ravi-voice-decline').textContent = voiceCopy('cancel');
    }
  }
  const controller = createRaviDictation({
    ...api, state, language: () => lang,
    consent: provider => invoke<boolean>('voice_consent', { provider }),
    saveConsent: (provider, allowed) => invoke('voice_set_consent', { provider, allowed }),
    cancelRequest: () => { void invoke('voice_cancel').catch(() => {}); },
    transcribe: (provider, audio, mime, durationMs, language) => invoke<string>('voice_transcribe', { provider, audio, mime, durationMs, language }),
    getUserMedia: navigator.mediaDevices?.getUserMedia ? () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }) : undefined,
    Recognition: (window as Window & { SpeechRecognition?: new () => LocalRecognition; webkitSpeechRecognition?: new () => LocalRecognition }).SpeechRecognition || (window as Window & { webkitSpeechRecognition?: new () => LocalRecognition }).webkitSpeechRecognition,
    Recorder: window.MediaRecorder, Audio: window.AudioContext,
    now: () => performance.now(), every: callback => setInterval(callback, 100), clear: timer => clearInterval(timer),
    level(ms, samples) {
      elapsed.textContent = `${Math.floor(ms / 1000)} / 30 s`;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.clearRect(0,0,canvas.width,canvas.height); ctx.strokeStyle = '#45a88a'; ctx.lineWidth = 2; ctx.beginPath();
      samples.forEach((v,i) => { const x=i*canvas.width/samples.length, y=v/255*canvas.height; if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); }); ctx.stroke();
    },
  });
  mic.hidden = false;
  mic.onclick = () => { channel?.postMessage('stop'); void controller.begin(); };
  el('ravi-voice-agree').onclick = () => { void controller.agree(); };
  el('ravi-voice-decline').onclick = () => controller.stop();
  settings.onclick = () => { void invoke('voice_open_microphone_settings').catch(() => { note.textContent = voiceCopy('settings'); }); };
  revoke.textContent = voiceCopy('revoke');
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('rv-voice-controls');
  if (channel) channel.onmessage = () => controller.stop();
  window.addEventListener('storage', event => { if (event.key === 'rv-voice-provider') controller.stop(); });
  revoke.onclick = async () => { channel?.postMessage('stop'); revoke.disabled = true; await controller.revoke(); revoke.disabled = false; revokeNote.textContent = voiceCopy(controller.state === 'error' ? 'storage' : 'revoked'); };
  (document.getElementById('chat-q') || document.getElementById('question'))?.addEventListener('input', event => {
    if (event.isTrusted && ['requesting','listening','transcribing'].includes(controller.state)) controller.stop();
  });
  const languageObserver = new MutationObserver(() => { controller.stop(); revoke.textContent = voiceCopy('revoke'); });
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  return controller;
}
