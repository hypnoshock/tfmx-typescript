/**
 * TFMX Audio Output
 * Ported from audio.c
 *
 * Uses Web Audio API to generate audio output. The player engine runs
 * on the main thread and generates samples in a ScriptProcessorNode callback.
 * This mirrors how the C version works with SDL's audio callback.
 */

import { TFMXPlayer } from './TFMXPlayer';
import type { TFMXData } from './types';
import type { Hdb } from './types';
import { DEFAULT_OUT_RATE } from './constants';

// Size of the mixing buffer (per channel, in samples)
const MIX_BUFFER_SIZE = 8192;

export class TFMXAudio {
  private player: TFMXPlayer;
  private audioCtx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private data: TFMXData | null = null;

  // Mixing buffers: left and right channels (S32 equivalent)
  private mixBufL: Float64Array = new Float64Array(MIX_BUFFER_SIZE);
  private mixBufR: Float64Array = new Float64Array(MIX_BUFFER_SIZE);

  // Timing state (ported from try_to_makeblock in audio.c)
  private eRem = 0;
  private blockDone = 0;

  // Oversampling (linear interpolation)
  private oversampling = true;

  // Stereo blend
  private blend = 1; // 0=stereo, 1=headphone blend

  // Low-pass filter state
  private filtLevel = 0; // 0=off, 1-3=increasing filter
  private filterStateL = 0;
  private filterStateR = 0;

  private _paused = true;
  private _hasPlayed = false;

  constructor() {
    this.player = new TFMXPlayer();
  }

  get playerInstance(): TFMXPlayer {
    return this.player;
  }

  get isPaused(): boolean {
    return this._paused;
  }

  get isLoaded(): boolean {
    return this.data !== null;
  }

  /**
   * True when playback was started and then paused — i.e. resume is possible.
   */
  get canResume(): boolean {
    return this._hasPlayed && this._paused;
  }

  /**
   * Load TFMX module data
   */
  load(data: TFMXData): void {
    this.data = data;
    this.player.loadData(data);
    this.player.tfmxInit();
    this._hasPlayed = false;
  }

  /**
   * Start or resume playback of a sub-song
   */
  play(songNum: number = 0): void {
    if (!this.data) return;

    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: DEFAULT_OUT_RATE });
    }

    this.player.outRate = this.audioCtx.sampleRate;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    // Reset mixing state
    this.eRem = 0;
    this.blockDone = 0;
    this.mixBufL.fill(0);
    this.mixBufR.fill(0);
    this.filterStateL = 0;
    this.filterStateR = 0;

    // Init and start the player engine
    this.player.tfmxInit();
    this.player.startSong(songNum);

    // Create ScriptProcessorNode if needed
    if (!this.scriptNode) {
      // Buffer size of 4096 gives ~93ms latency at 44100Hz. Good balance.
      this.scriptNode = this.audioCtx.createScriptProcessor(4096, 0, 2);
      this.scriptNode.onaudioprocess = (e) => this.audioProcess(e);
      this.scriptNode.connect(this.audioCtx.destination);
    }

    this._paused = false;
    this._hasPlayed = true;
  }

  /**
   * Pause playback — suspends the AudioContext so the browser stops
   * the ScriptProcessorNode callback (avoids silent-output issues).
   */
  pause(): void {
    this._paused = true;
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this.audioCtx.suspend();
    }
  }

  /**
   * Resume playback from where it was paused.
   * Player state is preserved — the song continues from the same position.
   */
  resume(): void {
    if (!this.data || !this.audioCtx) return;
    this._paused = false;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  /**
   * Trigger a macro for preview playback.
   * If a song is already playing, the macro is triggered on channel 0.
   * If nothing is playing, the engine is put into preview mode and started.
   */
  triggerMacro(macroNum: number, noteNum: number = 0x1E): void {
    if (!this.data) return;

    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: DEFAULT_OUT_RATE });
    }
    this.player.outRate = this.audioCtx.sampleRate;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    // Always stop any running song and switch to isolated preview mode.
    // Macros are instruments — we want to hear them in isolation, not on
    // top of whatever song is currently playing.
    this.player.tfmxInit();
    this.player.enableForPreview();

    // Reset mixing state
    this.eRem = 0;
    this.blockDone = 0;
    this.mixBufL.fill(0);
    this.mixBufR.fill(0);
    this.filterStateL = 0;
    this.filterStateR = 0;

    this.player.triggerMacro(macroNum, noteNum);

    // Ensure ScriptProcessorNode is running
    if (!this.scriptNode) {
      this.scriptNode = this.audioCtx.createScriptProcessor(4096, 0, 2);
      this.scriptNode.onaudioprocess = (e) => this.audioProcess(e);
      this.scriptNode.connect(this.audioCtx.destination);
    }

    this._paused = false;
  }

  /**
   * Play a raw sample region using Web Audio API directly.
   * Used by the sample explorer for quick previews.
   */
  playSample(sampleData: Float32Array, sampleRate: number = 16574): void {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: DEFAULT_OUT_RATE });
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const buffer = this.audioCtx.createBuffer(1, sampleData.length, sampleRate);
    buffer.copyToChannel(sampleData, 0);
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);
    source.start();
  }

  /**
   * Stop and clean up
   */
  stop(): void {
    this._paused = true;
    this.player.allOff();
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  /**
   * Audio processing callback - generates samples.
   * This is the main audio loop, equivalent to try_to_makeblock + fill_audio in audio.c.
   */
  private audioProcess(event: AudioProcessingEvent): void {
    const outputL = event.outputBuffer.getChannelData(0);
    const outputR = event.outputBuffer.getChannelData(1);
    const numSamples = outputL.length;

    if (this._paused || !this.player.isPlaying) {
      outputL.fill(0);
      outputR.fill(0);
      return;
    }

    let samplesWritten = 0;

    while (samplesWritten < numSamples && this.player.isPlaying) {
      // How many samples do we still have from the last tick?
      if (this.blockDone > 0) {
        // We have mixed samples ready - copy them to output
        const toCopy = Math.min(this.blockDone, numSamples - samplesWritten);
        const srcOffset = this.getSrcOffset(toCopy);

        for (let i = 0; i < toCopy; i++) {
          outputL[samplesWritten + i] = this.mixBufL[srcOffset + i] / 32768.0;
          outputR[samplesWritten + i] = this.mixBufR[srcOffset + i] / 32768.0;
        }

        // Shift remaining samples
        this.shiftMixBuffer(srcOffset, toCopy);
        this.blockDone -= toCopy;
        samplesWritten += toCopy;
        continue;
      }

      // Generate new samples by ticking the player
      this.player.tfmxIrqIn();

      // Calculate how many output samples this tick produces
      // Ported from try_to_makeblock in audio.c:
      //   nb = (eClocks * (outRate >> 1))
      //   eRem += (nb % 357955)
      //   nb /= 357955
      //   if (eRem > 357955) nb++, eRem -= 357955
      const outRate = this.player.outRate;
      let nb = this.player.eClocks * (outRate >> 1);
      this.eRem += nb % 357955;
      nb = Math.floor(nb / 357955);
      if (this.eRem > 357955) {
        nb++;
        this.eRem -= 357955;
      }

      if (nb <= 0) nb = 1;
      if (nb > MIX_BUFFER_SIZE) nb = MIX_BUFFER_SIZE;

      // Clear mix buffers for this tick
      for (let i = 0; i < nb; i++) {
        this.mixBufL[i] = 0;
        this.mixBufR[i] = 0;
      }

      // Mix all channels
      this.mixChannels(nb);

      // Apply filter and stereo blend
      this.applyFilter(nb);
      this.applyStereoBlend(nb);

      this.blockDone = nb;
    }

    // Fill remaining with silence if player stopped
    while (samplesWritten < numSamples) {
      outputL[samplesWritten] = 0;
      outputR[samplesWritten] = 0;
      samplesWritten++;
    }
  }

  private getSrcOffset(_toCopy: number): number {
    // We always read from the start of the mix buffer
    return 0;
  }

  private shiftMixBuffer(srcOffset: number, count: number): void {
    // Shift remaining data to the front
    const remaining = this.blockDone - count;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) {
        this.mixBufL[i] = this.mixBufL[srcOffset + count + i];
        this.mixBufR[i] = this.mixBufR[srcOffset + count + i];
      }
    }
  }

  /**
   * Mix all hardware channels into the L/R buffers.
   * Ported from mixit() in audio.c.
   *
   * Channel mapping (normal mode):
   *   Channels 0, 3 -> Left
   *   Channels 1, 2 -> Right
   *
   * In multimode, channels 4-7 are also mixed in.
   */
  private mixChannels(numSamples: number): void {
    if (this.player.multimode) {
      this.mixAdd(this.player.hdb[4], numSamples, this.mixBufL);
      this.mixAdd(this.player.hdb[5], numSamples, this.mixBufL);
      this.mixAdd(this.player.hdb[6], numSamples, this.mixBufL);
      this.mixAdd(this.player.hdb[7], numSamples, this.mixBufL);
    } else {
      this.mixAdd(this.player.hdb[3], numSamples, this.mixBufL);
    }
    this.mixAdd(this.player.hdb[0], numSamples, this.mixBufL);
    this.mixAdd(this.player.hdb[1], numSamples, this.mixBufR);
    this.mixAdd(this.player.hdb[2], numSamples, this.mixBufR);
  }

  /**
   * Mix a single hardware channel into a buffer.
   * Ported from mix_add() / mix_add_ov() in audio.c.
   */
  private mixAdd(hw: Hdb, n: number, buf: Float64Array): void {
    if (!this.data) return;

    const smplbuf = this.data.smplbuf;
    let p = hw.sbeg; // offset into smplbuf
    let ps = hw.pos;  // fixed-point position (14-bit fraction)
    const v = Math.min(hw.vol, 0x40);
    let d = hw.delta;
    let l = hw.slen << 14;

    if ((hw.mode & 1) === 0 || l < 0x10000) return;
    if (!v && !d) return;

    if ((hw.mode & 3) === 1) {
      p = hw.sbeg = hw.SampleStart;
      l = (hw.slen = hw.SampleLength) << 14;
      ps = 0;
      hw.mode |= 2;
    }

    if (!v) {
      // Volume 0 - still advance position but don't mix
      hw.sbeg = p;
      hw.pos = ps;
      hw.delta = d;
      return;
    }

    for (let i = 0; i < n; i++) {
      ps += d;

      const sampleIdx = p + (ps >> 14);
      if (sampleIdx >= 0 && sampleIdx < smplbuf.length) {
        if (this.oversampling) {
          // Linear interpolation (mix_add_ov)
          const v1 = smplbuf[sampleIdx] || 0;
          const nextIdx = sampleIdx + 1;
          const v2 = (nextIdx < smplbuf.length) ? (smplbuf[nextIdx] || 0) : 0;
          const frac = ps & 0x3FFF;
          const sample = v1 + (((v2 - v1) * frac) >> 14);
          buf[i] += sample * v;
        } else {
          buf[i] += (smplbuf[sampleIdx] || 0) * v;
        }
      }

      if (ps < l) continue;

      // Loop point
      ps -= l;
      p = hw.SampleStart;
      const newLen = hw.SampleLength;
      hw.slen = newLen;
      l = newLen << 14;

      if (l < 0x10000 || !hw.loop(hw)) {
        hw.slen = 0;
        ps = 0;
        d = 0;
        p = 0;
        break;
      }
    }

    hw.sbeg = p;
    hw.pos = ps;
    hw.delta = d;
    if (hw.mode & 4) hw.mode = 0;
  }

  /**
   * Simple 3-position weighted-sum low-pass filter.
   * Ported from filter() in audio.c.
   */
  private applyFilter(num: number): void {
    if (!this.filtLevel) return;

    for (let i = 0; i < num; i++) {
      switch (this.filtLevel) {
        case 3:
          this.filterStateL = (this.mixBufL[i] + this.filterStateL * 3) / 4;
          this.filterStateR = (this.mixBufR[i] + this.filterStateR * 3) / 4;
          break;
        case 2:
          this.filterStateL = (this.mixBufL[i] + this.filterStateL) / 2;
          this.filterStateR = (this.mixBufR[i] + this.filterStateR) / 2;
          break;
        case 1:
          this.filterStateL = (this.mixBufL[i] * 3 + this.filterStateL) / 4;
          this.filterStateR = (this.mixBufR[i] * 3 + this.filterStateR) / 4;
          break;
      }
      this.mixBufL[i] = this.filterStateL;
      this.mixBufR[i] = this.filterStateR;
    }
  }

  /**
   * Stereo blend for headphone listening.
   * Ported from stereoblend() in audio.c.
   */
  private applyStereoBlend(num: number): void {
    if (!this.blend) return;

    for (let i = 0; i < num; i++) {
      const l = this.mixBufL[i];
      const r = this.mixBufR[i];
      this.mixBufL[i] = (l * 11 + r * 5) / 16;
      this.mixBufR[i] = (r * 11 + l * 5) / 16;
    }
  }
}

