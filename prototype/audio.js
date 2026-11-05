// Basic audio feedback: short tones (Web Audio) + spoken sentences (Web Speech).

const TONES = {
  // [frequency Hz, start s, length s]
  enter: [[523, 0, 0.09], [784, 0.1, 0.14]],      // rising
  leave: [[784, 0, 0.09], [523, 0.1, 0.14]],      // falling
  placed: [[659, 0, 0.12]],
  removed: [[330, 0, 0.18]],
  near: [[880, 0, 0.06]],
  'not-near': [[440, 0, 0.06]],
  adjacent: [[988, 0, 0.06], [988, 0.09, 0.06]], // double blip
  apart: [[392, 0, 0.06], [392, 0.09, 0.06]],
};
const RANK = ['enter', 'leave', 'placed', 'removed', 'adjacent', 'apart', 'near', 'not-near'];

export class Speaker {
  constructor(opts = {}) {
    this.speech = opts.speech ?? true;
    this.tones = opts.tones ?? true;
    this.rate = opts.rate ?? 1.1;
    this.voiceURI = opts.voiceURI ?? null;
    this.synth = window.speechSynthesis ?? null;
    this.ctx = null;
    this.onSay = () => {}; // (text) => void, e.g. to show the sentence on screen
  }

  get supported() { return { speech: !!this.synth, tones: !!(window.AudioContext || window.webkitAudioContext) }; }

  voices() { return this.synth ? this.synth.getVoices().filter((v) => v.lang?.startsWith('en')) : []; }

  // Tones need an AudioContext, which browsers only start after a click or key press.
  unlock() {
    if (!this.ctx && this.supported.tones) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx?.resume();
  }

  tone(type) {
    if (!this.tones || !this.ctx || !TONES[type]) return;
    const t0 = this.ctx.currentTime + 0.01;
    for (const [f, start, len] of TONES[type]) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(0.25, t0 + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + start + len);
      o.connect(g).connect(this.ctx.destination);
      o.start(t0 + start); o.stop(t0 + start + len + 0.02);
    }
  }

  /** Events from one update: one tone for the most important, one combined sentence. */
  announce(events) {
    if (!events.length) return;
    const top = [...events].sort((a, b) => RANK.indexOf(a.type) - RANK.indexOf(b.type))[0];
    this.tone(top.type);
    this.say(events.map((e) => e.text).join('. '));
  }

  say(text, { interrupt = false } = {}) {
    this.onSay(text);
    if (!this.speech || !this.synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    const v = this.voices().find((k) => k.voiceURI === this.voiceURI);
    if (v) u.voice = v;
    // Chrome's speech queue is shared by the whole browser and can get stuck, which silences
    // everything after it. Clear it, then speak a moment later (Chrome ignores a speak()
    // issued immediately after cancel()). The newest announcement wins.
    if (interrupt || this.synth.speaking || this.synth.pending) this.synth.cancel();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.synth.speak(u), 100);
  }

  stop() { this.synth?.cancel(); }
}
