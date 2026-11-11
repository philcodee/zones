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

// Mixer levels are 0..1. At 1 a channel plays at these peak gains; the defaults (0.5) match the
// levels the sounds had before the mixer existed.
export const MIX_DEFAULT = { master: 1, speech: 1, tones: 0.5, ticks: 0.5, pad: 0.5 };
const FULL = { tones: 0.5, ticks: 4, pad: 0.6 }; // ticks are ~2 ms of noise, so they need more gain to be heard

export class Speaker {
  constructor(opts = {}) {
    this.speech = opts.speech ?? true;
    this.tones = opts.tones ?? true;
    this.rate = opts.rate ?? 1.1;
    this.voiceURI = opts.voiceURI ?? null;
    this.synth = window.speechSynthesis ?? null;
    this.ctx = null;
    this.out = null; // master bus: gain -> limiter -> speakers
    this.mix = { ...MIX_DEFAULT, ...(opts.mix || {}) };
    this.onSay = () => {}; // (text) => void, e.g. to show the sentence on screen
  }

  /** Change one or more mixer levels (0..1). Master applies to everything, speech included. */
  setMix(m) {
    Object.assign(this.mix, m);
    if (this.out) this.out.gain.setTargetAtTime(this.mix.master, this.ctx.currentTime, 0.02);
  }

  /** Peak gain for a Web Audio channel ('tones' | 'ticks'); master is applied on the bus. */
  level(ch) { return FULL[ch] * this.mix[ch]; }

  get supported() { return { speech: !!this.synth, tones: !!(window.AudioContext || window.webkitAudioContext) }; }

  voices() { return this.synth ? this.synth.getVoices().filter((v) => v.lang?.startsWith('en')) : []; }

  // Tones need an AudioContext, which browsers only start after a click or key press.
  unlock() {
    if (!this.ctx && this.supported.tones) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // A limiter after the master gain keeps loud mixes from clipping.
      const lim = this.ctx.createDynamicsCompressor();
      lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
      this.out = this.ctx.createGain();
      this.out.gain.value = this.mix.master;
      this.out.connect(lim).connect(this.ctx.destination);
    }
    this.ctx?.resume();
  }

  /** Play a named tone. `force` plays it even when tones are switched off (mixer preview). */
  tone(type, { force = false } = {}) {
    if ((!this.tones && !force) || !this.ctx || !TONES[type]) return;
    const peak = this.level('tones');
    if (peak <= 0) return;
    const t0 = this.ctx.currentTime + 0.01;
    for (const [f, start, len] of TONES[type]) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(peak, t0 + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + start + len);
      o.connect(g).connect(this.out);
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

  say(text, { interrupt = false, force = false } = {}) {
    this.onSay(text);
    if ((!this.speech && !force) || !this.synth) return;
    const vol = Math.min(1, this.mix.speech * this.mix.master); // speech can't go above the system's 100%
    if (vol <= 0) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    u.volume = vol;
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

/**
 * Sonar clicks, one stream per pointer. Faster clicks = closer target.
 * Uses the Speaker's AudioContext (so it needs the same unlock) and schedules clicks a
 * little ahead on the audio clock, so timing stays even when the page is busy.
 */
export class Sonar {
  constructor(speaker) {
    this.speaker = speaker;
    this.enabled = true;
    this.streams = new Map(); // id -> { intervalMs, pitch, next }
    this.timer = null;
  }

  /**
   * Set or clear one pointer's stream. `null` = silent (nothing in the beam / pointer gone).
   * `{ pad: true, gain }` = this pointer has found the easter egg: its ticks stop and the warm pad
   * plays at `gain` (0..1, from distance). With two pointers on the egg, the closer one sets the level.
   */
  set(id, s) {
    const cur = this.streams.get(id), ctx = this.speaker.ctx;
    if (!s) { this.streams.delete(id); return this._run(); }
    const now = ctx ? ctx.currentTime : 0;
    if (!cur || !!cur.pad !== !!s.pad) this.streams.set(id, { ...s, next: now + 0.02, last: null });
    else if (s.pad) cur.gain = s.gain;
    else {
      // Closing in should be heard right away: pull the next click earlier if the new period is shorter.
      if (cur.last != null && s.intervalMs < cur.intervalMs) cur.next = Math.max(now + 0.01, Math.min(cur.next, cur.last + s.intervalMs / 1000));
      cur.intervalMs = s.intervalMs; cur.pitch = s.pitch;
    }
    this._run();
  }

  clear() { this.streams.clear(); this._run(); }

  /** A few ticks at a steady pace, for setting the level. Plays even when pointer ticks are off. */
  preview(pitch = 3000, n = 5, gapMs = 150) {
    const ctx = this.speaker.ctx;
    if (!ctx) return;
    for (let i = 0; i < n; i++) this.click(pitch, ctx.currentTime + 0.03 + (i * gapMs) / 1000);
  }

  /** Play the pad for a few seconds, for setting its level. */
  previewPad(seconds = 3) {
    if (!this.speaker.ctx) return;
    this.previewing = true;
    this._syncPad();
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => { this.previewing = false; this._syncPad(); }, seconds * 1000);
  }

  _run() {
    const want = this.streams.size > 0;
    if (want && !this.timer) this.timer = setInterval(() => this._tick(), 25);
    if (!want && this.timer) { clearInterval(this.timer); this.timer = null; }
    this._syncPad();
  }

  /** One shared pad, on while any pointer has found the egg (and pointer sounds are on). */
  _syncPad() {
    const pads = this.enabled ? [...this.streams.values()].filter((s) => s.pad) : [];
    if (pads.length || this.previewing) this._padOn(this.previewing ? 1 : Math.max(...pads.map((s) => s.gain ?? 1)));
    else this._padOff();
  }

  _padOn(gain = 1) {
    const ctx = this.speaker.ctx;
    if (!ctx) return;
    const level = this.speaker.level('pad') * gain;
    // Follow distance and the mixer quickly (~0.25 s), so moving closer is heard right away.
    if (this.pad) { this.pad.out.gain.setTargetAtTime(level, ctx.currentTime, 0.08); return; }
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.setTargetAtTime(level, now, 0.08);
    // Warm = low-passed, with the cutoff breathing slowly.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 750; lp.Q.value = 0.8;
    const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.12; lfoAmt.gain.value = 280;
    lfo.connect(lfoAmt).connect(lp.frequency);
    // Cmaj9 voiced wide (C3 G3 B3 D4 E4), two detuned saws per note, plus a soft sine an octave below the root.
    const notes = [130.81, 196.0, 246.94, 293.66, 329.63], oscs = [lfo];
    const voice = 1 / (notes.length * 2);
    for (const f of notes) for (const cents of [-8, 8]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = cents;
      g.gain.value = voice;
      o.connect(g).connect(lp);
      oscs.push(o);
    }
    const sub = ctx.createOscillator(), subG = ctx.createGain();
    sub.type = 'sine'; sub.frequency.value = 65.41; subG.gain.value = 0.25;
    sub.connect(subG).connect(out);
    oscs.push(sub);
    lp.connect(out).connect(this.speaker.out);
    for (const o of oscs) o.start(now);
    this.pad = { out, oscs };
  }

  _padOff() {
    const ctx = this.speaker.ctx;
    if (!this.pad || !ctx) return;
    const { out, oscs } = this.pad, now = ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.setTargetAtTime(0, now, 0.6); // gentle fade, ~2 s
    for (const o of oscs) o.stop(now + 4);
    this.pad = null;
  }

  _tick() {
    const ctx = this.speaker.ctx;
    this._syncPad(); // picks up the on/off switch and mixer changes
    if (!ctx || !this.enabled) return;
    const horizon = ctx.currentTime + 0.1;
    for (const s of this.streams.values()) {
      if (s.pad) continue; // this pointer is on the egg: pad instead of ticks
      if (s.next < ctx.currentTime) s.next = ctx.currentTime + 0.01; // fell behind (tab was hidden)
      while (s.next < horizon) {
        this.click(s.pitch, s.next);
        s.last = s.next;
        s.next += s.intervalMs / 1000;
      }
    }
  }

  /**
   * One dry "tick", like a clock or Geiger counter: a ~5 ms burst of noise through a band-pass
   * filter. `pitch` is the filter's centre, so each pointer gets its own colour of tick.
   */
  click(pitch = 3000, at = this.speaker.ctx?.currentTime ?? 0) {
    const ctx = this.speaker.ctx;
    const vol = this.speaker.level('ticks');
    if (!ctx || vol <= 0) return;
    if (!this.noise || this.noise.sampleRate !== ctx.sampleRate) {
      // 2 ms buffer, ~0.3 ms decay: an instant attack and almost no tail.
      const n = Math.round(ctx.sampleRate * 0.002), tau = ctx.sampleRate * 0.0003;
      this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
      const ch = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / tau);
    }
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    bp.type = 'bandpass'; bp.frequency.value = pitch; bp.Q.value = 1.2; // low Q = no ringing after the tick
    g.gain.value = vol; // a filtered noise burst is quiet, hence the higher full-scale gain
    src.connect(bp).connect(g).connect(this.speaker.out);
    src.start(at);
  }
}
