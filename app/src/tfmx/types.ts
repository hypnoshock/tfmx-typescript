/**
 * TFMX Type Definitions
 * Ported from player.h, tfmxsong.h, tfmxplay.h
 */

/**
 * Hardware DMA channel state.
 * Ported from struct Hdb in player.h
 */
export interface Hdb {
  pos: number;           // U32 - fixed-point sample position
  delta: number;         // U32 - fixed-point step per output sample
  slen: number;          // U16 - current sample length (in bytes)
  SampleLength: number;  // U16 - loop sample length
  sbeg: number;          // offset into smplbuf (current play pointer)
  SampleStart: number;   // offset into smplbuf (loop start)
  vol: number;           // U8  - channel volume (0-64)
  mode: number;          // U8  - DMA mode flags
  loop: LoopFunc;        // loop callback
  loopcnt: number;
  cIdx: number;          // index into cdb[] (replaces pointer)
}

export type LoopFunc = (hw: Hdb) => number;

/**
 * Cue / signal database.
 * Ported from struct Idb in player.h
 */
export interface Idb {
  Cue: number[];  // U16[4]
}

/**
 * Master database - global player state.
 * Ported from struct Mdb in player.h
 */
export interface Mdb {
  PlayerEnable: number;   // char (0/1)
  EndFlag: number;        // char
  CurrSong: number;       // char
  SpeedCnt: number;       // U16
  CIASave: number;        // U16
  SongCont: number;       // char
  SongNum: number;        // char
  PlayPattFlag: number;   // U16
  MasterVol: number;      // char
  FadeDest: number;       // char
  FadeTime: number;       // char
  FadeReset: number;      // char
  FadeSlope: number;      // char
  TrackLoop: number;      // S16
  DMAon: number;          // U16
  DMAoff: number;         // U16
  DMAstate: number;       // U16
  DMAAllow: number;       // U16
}

/**
 * Pattern database - one per track.
 * Ported from struct Pdb in player.h
 */
export interface Pdb {
  PAddr: number;     // U32 - pattern address (index into editbuf)
  PNum: number;      // U8  - pattern number
  PXpose: number;    // S8  - transpose value
  PLoop: number;     // U16 - loop counter
  PStep: number;     // U16 - current step in pattern
  PWait: number;     // U8  - wait counter
  PRoAddr: number;   // U16 - return address for GsPt
  PRoStep: number;   // U16 - return step for GsPt
}

/**
 * Pattern block - holds all 8 track pattern states.
 * Ported from struct Pdblk in player.h
 */
export interface Pdblk {
  FirstPos: number;   // U16
  LastPos: number;    // U16
  CurrPos: number;    // U16
  Prescale: number;   // U16
  p: Pdb[];           // [8]
}

/**
 * Channel database - one per voice (up to 16).
 * Ported from struct Cdb in player.h
 */
export interface Cdb {
  MacroRun: number;       // S8
  EfxRun: number;         // S8
  NewStyleMacro: number;  // U8
  PrevNote: number;       // U8
  CurrNote: number;       // U8
  Velocity: number;       // U8
  Finetune: number;       // U8
  KeyUp: number;          // U8
  ReallyWait: number;     // U8
  MacroPtr: number;       // U32
  MacroStep: number;      // U16
  MacroWait: number;      // U16
  MacroNum: number;       // U16
  Loop: number;           // S16

  CurAddr: number;        // U32
  SaveAddr: number;       // U32
  CurrLength: number;     // U16
  SaveLen: number;        // U16

  WaitDMACount: number;   // U16
  DMABit: number;         // U16

  EnvReset: number;       // U8
  EnvTime: number;        // U8
  EnvRate: number;        // U8
  EnvEndvol: number;      // S8
  CurVol: number;         // S8

  VibOffset: number;      // S16
  VibWidth: number;       // S8
  VibFlag: number;        // U8
  VibReset: number;       // U8
  VibTime: number;        // U8

  PortaReset: number;     // U8
  PortaTime: number;      // U8
  CurPeriod: number;      // U16
  DestPeriod: number;     // U16
  PortaPer: number;       // U16
  PortaRate: number;      // S16

  AddBeginTime: number;   // U8
  AddBeginReset: number;  // U8
  ReturnPtr: number;      // U16
  ReturnStep: number;     // U16
  AddBegin: number;       // S32

  SfxFlag: number;        // U8
  SfxPriority: number;    // U8
  SfxNum: number;         // U8
  SfxLockTime: number;    // S16
  SfxCode: number;        // U32

  hwIdx: number;          // index into hdb[] (replaces pointer)
}

/**
 * MDAT file header.
 * Ported from struct Hdr in tfmxsong.h
 */
export interface Hdr {
  magic: string;           // 10 bytes
  text: string[];          // 6 x 40-char strings
  start: number[];         // U16[32] - song start positions
  end: number[];           // U16[32] - song end positions
  tempo: number[];         // U16[32] - tempo values
  trackstart: number;      // offset (converted to editbuf index)
  pattstart: number;       // offset (converted to editbuf index)
  macrostart: number;      // offset (converted to editbuf index)
}

/**
 * Parsed TFMX module data, ready for the player.
 */
export interface TFMXData {
  hdr: Hdr;
  editbuf: Int32Array;     // main data buffer (32-bit words)
  smplbuf: Int8Array;      // sample data
  patterns: number[];      // pattern pointer table (indices into editbuf)
  macros: number[];        // macro pointer table (indices into editbuf)
  numPatterns: number;
  numMacros: number;
  numTracksteps: number;
}

/**
 * Helper to extract big-endian bytes/words from a 32-bit value.
 * Replaces the C UNI union.
 * For a value 0x12345678:
 *   b0=0x12, b1=0x34, b2=0x56, b3=0x78
 *   w0=0x1234, w1=0x5678
 */
export class UNI {
  l: number;

  constructor(val: number) {
    this.l = val >>> 0; // force unsigned 32-bit
  }

  get b0(): number { return (this.l >>> 24) & 0xFF; }
  get b1(): number { return (this.l >>> 16) & 0xFF; }
  get b2(): number { return (this.l >>> 8) & 0xFF; }
  get b3(): number { return this.l & 0xFF; }

  get w0(): number { return (this.l >>> 16) & 0xFFFF; }
  get w1(): number { return this.l & 0xFFFF; }

  set b0(v: number) { this.l = ((v & 0xFF) << 24) | (this.l & 0x00FFFFFF); this.l >>>= 0; }
  set b1(v: number) { this.l = ((v & 0xFF) << 16) | (this.l & 0xFF00FFFF); this.l >>>= 0; }
  set b2(v: number) { this.l = ((v & 0xFF) << 8) | (this.l & 0xFFFF00FF); this.l >>>= 0; }
  set b3(v: number) { this.l = (v & 0xFF) | (this.l & 0xFFFFFF00); this.l >>>= 0; }

  set w0(v: number) { this.l = ((v & 0xFFFF) << 16) | (this.l & 0x0000FFFF); this.l >>>= 0; }
  set w1(v: number) { this.l = (v & 0xFFFF) | (this.l & 0xFFFF0000); this.l >>>= 0; }
}

/**
 * Helper: interpret a number as signed 8-bit
 */
export function toS8(v: number): number {
  v = v & 0xFF;
  return v > 127 ? v - 256 : v;
}

/**
 * Helper: interpret a number as signed 16-bit
 */
export function toS16(v: number): number {
  v = v & 0xFFFF;
  return v > 32767 ? v - 65536 : v;
}

/**
 * Helper: interpret a number as signed 32-bit
 */
export function toS32(v: number): number {
  return v | 0;
}

