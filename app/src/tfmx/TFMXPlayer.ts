/**
 * TFMX Player Engine
 * Ported from player.c
 *
 * This is the core tick-based player engine. It processes tracksteps,
 * patterns, macros, and effects each "jiffy" (tick). It does NOT produce
 * audio samples directly - that's handled by the mixer/audio layer.
 */

import type {
  Hdb, Mdb, Cdb, Pdb, Pdblk, Idb, TFMXData, LoopFunc,
} from './types';
import { UNI, toS8, toS16 } from './types';
import { NOTEVALS, DEFAULT_ECLOCKS } from './constants';

export class TFMXPlayer {
  // --- Player state (ported from globals in player.c) ---
  hdb: Hdb[] = [];
  mdb: Mdb = this.createMdb();
  cdb: Cdb[] = [];
  pdb: Pdblk = this.createPdblk();
  idb: Idb = { Cue: [0, 0, 0, 0] };

  // Module data
  private data: TFMXData | null = null;

  // Timing
  jiffies = 0;
  multimode = 0;
  eClocks = DEFAULT_ECLOCKS;

  // Config
  gemx = 0;
  dangerFreakHack = 0;
  loops = 0; // 0 = infinite looping, >0 = number of loops, <0 = stop at end

  // Track muting (8 tracks)
  trackMuted: boolean[] = Array(8).fill(false);

  // Output rate (needed for period -> delta conversion)
  outRate = 44100;

  constructor() {
    this.initStructs();
  }

  private createMdb(): Mdb {
    return {
      PlayerEnable: 0,
      EndFlag: 0,
      CurrSong: 0,
      SpeedCnt: 0,
      CIASave: 0,
      SongCont: 0,
      SongNum: 0,
      PlayPattFlag: 0,
      MasterVol: 0x40,
      FadeDest: 0,
      FadeTime: 0,
      FadeReset: 0,
      FadeSlope: 0,
      TrackLoop: -1,
      DMAon: 0,
      DMAoff: 0,
      DMAstate: 0,
      DMAAllow: 0,
    };
  }

  private createPdb(): Pdb {
    return {
      PAddr: 0,
      PNum: 0xFF,
      PXpose: 0,
      PLoop: 0xFFFF,
      PStep: 0,
      PWait: 0,
      PRoAddr: 0,
      PRoStep: 0,
    };
  }

  private createPdblk(): Pdblk {
    return {
      FirstPos: 0,
      LastPos: 0,
      CurrPos: 0,
      Prescale: 0,
      p: Array.from({ length: 8 }, () => this.createPdb()),
    };
  }

  private createHdb(idx: number): Hdb {
    return {
      pos: 0,
      delta: 0,
      slen: 2,
      SampleLength: 0,
      sbeg: 0,
      SampleStart: 0,
      vol: 0,
      mode: 0,
      loop: this.loopOff,
      loopcnt: 0,
      cIdx: idx,
    };
  }

  private createCdb(idx: number): Cdb {
    return {
      MacroRun: 0,
      EfxRun: 0,
      NewStyleMacro: 0xFF,
      PrevNote: 0,
      CurrNote: 0,
      Velocity: 0,
      Finetune: 0,
      KeyUp: 0,
      ReallyWait: 0,
      MacroPtr: 0,
      MacroStep: 0,
      MacroWait: 0,
      MacroNum: 0,
      Loop: -1,
      CurAddr: 0,
      SaveAddr: 0,
      CurrLength: 0,
      SaveLen: 2,
      WaitDMACount: 0,
      DMABit: 0,
      EnvReset: 0,
      EnvTime: 0,
      EnvRate: 0,
      EnvEndvol: 0,
      CurVol: 0,
      VibOffset: 0,
      VibWidth: 0,
      VibFlag: 0,
      VibReset: 0,
      VibTime: 0,
      PortaReset: 0,
      PortaTime: 0,
      CurPeriod: 0,
      DestPeriod: 0,
      PortaPer: 0,
      PortaRate: 0,
      AddBeginTime: 0,
      AddBeginReset: 0,
      ReturnPtr: 0,
      ReturnStep: 0,
      AddBegin: 0,
      SfxFlag: 0,
      SfxPriority: 0,
      SfxNum: 0,
      SfxLockTime: -1,
      SfxCode: 0,
      hwIdx: idx,
    };
  }

  private initStructs(): void {
    this.hdb = Array.from({ length: 8 }, (_, i) => this.createHdb(i));
    this.cdb = Array.from({ length: 16 }, (_, i) => this.createCdb(i));
  }

  // --- Loop callbacks ---
  loopOff: LoopFunc = (_hw: Hdb): number => {
    return 1;
  };

  loopOn: LoopFunc = (hw: Hdb): number => {
    const c = this.cdb[hw.cIdx];
    if (!c) return 1;
    if (c.WaitDMACount-- > 0) return 1;
    hw.loop = this.loopOff;
    c.MacroRun = -1; // 0xFF as S8
    return 1;
  };

  // --- Load module data ---
  loadData(data: TFMXData): void {
    this.data = data;
  }

  // --- Helper to read a 32-bit word from editbuf ---
  // The editbuf stores values in host order (already converted from big-endian at parse time)
  private readEditbuf(index: number): number {
    if (!this.data) return 0;
    if (index < 0 || index >= this.data.editbuf.length) return 0;
    return this.data.editbuf[index];
  }

  // --- Read a 16-bit value from the trackstep area ---
  // Trackstep is stored as 32-bit words but accessed as 16-bit values.
  // Each 32-bit word contains two 16-bit values (big-endian order).
  private readTrackstepWord(wordIndex: number): number {
    if (!this.data) return 0;
    const i32Index = this.data.hdr.trackstart + (wordIndex >> 1);
    const val = this.readEditbuf(i32Index);
    if (wordIndex & 1) {
      return val & 0xFFFF;
    } else {
      return (val >>> 16) & 0xFFFF;
    }
  }

  // --- NotePort: dispatches a note or command to a channel ---
  // Ported from NotePort() in player.c
  private notePort(i: number): void {
    const x = new UNI(i);
    const channelIdx = x.b2 & (this.multimode ? 7 : 3);
    const c = this.cdb[channelIdx];

    if (x.b0 === 0xFC) {
      // lock
      c.SfxFlag = x.b1;
      c.SfxLockTime = x.b3;
      return;
    }
    if (c.SfxFlag) return;

    if (x.b0 < 0xC0) {
      if (!this.dangerFreakHack) {
        c.Finetune = x.b3;
      } else {
        c.Finetune = 0;
      }
      c.Velocity = (x.b2 >> 4) & 0xF;
      c.PrevNote = c.CurrNote;
      c.CurrNote = x.b0;
      c.ReallyWait = 1;
      c.NewStyleMacro = 0xFF;
      c.MacroNum = x.b1;
      c.MacroPtr = this.data!.macros[x.b1] || 0;
      c.MacroStep = 0;
      c.EfxRun = 0;
      c.MacroWait = 0;
      c.KeyUp = 1;
      c.Loop = -1;
      c.MacroRun = -1;
    } else if (x.b0 < 0xF0) {
      // portamento note
      c.PortaReset = x.b1;
      c.PortaTime = 1;
      if (!c.PortaRate) c.PortaPer = c.DestPeriod;
      c.PortaRate = x.b3;
      c.CurrNote = x.b0 & 0x3F;
      c.DestPeriod = NOTEVALS[c.CurrNote] || 0;
    } else {
      switch (x.b0) {
        case 0xF7: // enve
          c.EnvRate = x.b1;
          c.EnvReset = c.EnvTime = (x.b2 >> 4) + 1;
          c.EnvEndvol = x.b3;
          break;
        case 0xF6: // vibr
          c.VibTime = (c.VibReset = x.b1 & 0xFE) >> 1;
          c.VibWidth = toS8(x.b3);
          c.VibFlag = 1;
          c.VibOffset = 0;
          break;
        case 0xF5: // kup^
          c.KeyUp = 0;
          break;
      }
    }
  }

  // --- RunMacro: execute macro commands for a channel ---
  // Ported from RunMacro() in player.c
  private runMacro(c: Cdb, nChannel: number): void {
    if (!this.data) return;
    c.MacroWait = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rawVal = this.readEditbuf(c.MacroPtr + c.MacroStep);
      c.MacroStep++;

      const x = new UNI(rawVal);
      const a = x.b0;
      x.b0 = 0;

      const hw = this.hdb[c.hwIdx];

      switch (a) {
        case 0x00: {
          // DMAoff+Reset
          c.EnvReset = 0;
          c.VibReset = 0;
          c.PortaRate = 0;
          c.AddBeginTime = 0;

          if (this.gemx) {
            if (x.b2) {
              c.CurVol = x.b3;
            } else {
              c.CurVol = x.b3 + c.Velocity * 3;
            }
          }
        }
        // fall through to DMAoff (0x13)
        // eslint-disable-next-line no-fallthrough
        case 0x13: {
          // DMAoff
          hw.loop = this.loopOff;
          if (!x.b1) {
            hw.mode = 0;
            if (c.NewStyleMacro) {
              hw.slen = 0;
            }
            break;
          } else {
            hw.mode |= 4;
            c.NewStyleMacro = 0;
            return;
          }
        }

        case 0x01: {
          // DMAon
          c.EfxRun = x.b1;
          hw.mode = 1;
          if (!c.NewStyleMacro || this.dangerFreakHack) {
            hw.SampleStart = c.SaveAddr;
            hw.SampleLength = c.SaveLen ? c.SaveLen << 1 : 131072;
            hw.sbeg = hw.SampleStart;
            hw.slen = hw.SampleLength;
            hw.pos = 0;
            hw.mode |= 2;
            break;
          } else {
            break;
          }
        }

        case 0x02: {
          // SetBegin
          c.AddBeginTime = 0;
          c.SaveAddr = c.CurAddr = x.l;
          break;
        }

        case 0x11: {
          // AddBegin
          c.AddBeginTime = c.AddBeginReset = x.b1;
          const delta = toS16(x.w1);
          c.AddBegin = delta;
          const addr = c.CurAddr + delta;
          c.SaveAddr = c.CurAddr = addr;
          break;
        }

        case 0x03: {
          // SetLen
          c.SaveLen = c.CurrLength = x.w1;
          break;
        }

        case 0x12: {
          // AddLen
          c.CurrLength = (c.CurrLength + x.w1) & 0xFFFF;
          c.SaveLen = c.CurrLength;
          break;
        }

        case 0x04: {
          // Wait
          if (x.b1 & 0x01) {
            if (c.ReallyWait++) {
              return;
            }
          }
          c.MacroWait = x.w1;
          // MAYBEWAIT
          if (c.NewStyleMacro === 0x00) {
            c.NewStyleMacro = 0xFF;
            break;
          } else {
            return;
          }
        }

        case 0x1A: {
          // Wait on DMA
          hw.loop = this.loopOn;
          hw.cIdx = nChannel;
          c.WaitDMACount = x.w1;
          c.MacroRun = 0;
          // MAYBEWAIT
          if (c.NewStyleMacro === 0x00) {
            c.NewStyleMacro = 0xFF;
            break;
          } else {
            return;
          }
        }

        case 0x1C: {
          // Note split
          if (c.CurrNote > x.b1) {
            c.MacroStep = x.w1;
          }
          break;
        }

        case 0x1D: {
          // Vol split
          if (c.CurVol > x.b1) {
            c.MacroStep = x.w1;
          }
          break;
        }

        case 0x1B: {
          // Random play (TODO)
          break;
        }

        case 0x1E: {
          // AddVol+Note (not fully implemented in reference - treated as TODO)
          break;
        }

        case 0x10: {
          // Loop key up: if key is released (KeyUp=0), break out of loop
          if (!c.KeyUp) {
            break;
          }
          // Otherwise fall through to regular loop logic
        }
        // eslint-disable-next-line no-fallthrough
        case 0x05: {
          // Loop: C code is if(!(c->Loop--)) break; else if(c->Loop<0) c->Loop=x.b1-1;
          // Post-decrement: check old value, then decrement
          {
            const oldLoop = c.Loop;
            c.Loop--;
            if (oldLoop === 0) {
              break;
            } else if (c.Loop < 0) {
              c.Loop = x.b1 - 1;
            }
          }
          c.MacroStep = x.w1;
          break;
        }

        case 0x07: {
          // Stop
          c.MacroRun = 0;
          return;
        }

        case 0x0D: {
          // AddVolume
          if (x.b2 !== 0xFE) {
            let tempVol = c.Velocity * 3 + toS8(x.b3);
            if (tempVol > 0x40) c.CurVol = 0x40;
            else if (tempVol < 0) c.CurVol = 0;
            else c.CurVol = tempVol;
            break;
          }
          // 0xFE variant - not supported
          break;
        }

        case 0x0E: {
          // SetVolume
          if (x.b2 !== 0xFE) {
            c.CurVol = x.b3;
            break;
          }
          // 0xFE variant - not supported
          break;
        }

        case 0x21: {
          // Play macro (start macro on another channel)
          const nx = new UNI(x.l);
          nx.b0 = c.CurrNote;
          nx.b2 = nx.b2 | (c.Velocity << 4);
          this.notePort(nx.l);
          break;
        }

        case 0x1F: {
          // Set prev note
          let noteA = c.PrevNote;
          noteA = (NOTEVALS[(noteA + x.b1) & 0x3F] || 0) *
                  (0x100 + c.Finetune + toS8(x.b3));
          noteA = noteA >> 8;
          c.DestPeriod = noteA;
          if (!c.PortaRate) c.CurPeriod = noteA;
          // MAYBEWAIT
          if (c.NewStyleMacro === 0x00) {
            c.NewStyleMacro = 0xFF;
            break;
          } else {
            return;
          }
        }

        case 0x08: {
          // AddNote
          let noteA = c.CurrNote;
          noteA = (NOTEVALS[(noteA + x.b1) & 0x3F] || 0) *
                  (0x100 + c.Finetune + toS8(x.b3));
          noteA = noteA >> 8;
          c.DestPeriod = noteA;
          if (!c.PortaRate) c.CurPeriod = noteA;
          // MAYBEWAIT
          if (c.NewStyleMacro === 0x00) {
            c.NewStyleMacro = 0xFF;
            break;
          } else {
            return;
          }
        }

        case 0x09: {
          // SetNote
          let noteA = (NOTEVALS[x.b1 & 0x3F] || 0) *
                      (0x100 + c.Finetune + toS8(x.b3));
          noteA = noteA >> 8;
          c.DestPeriod = noteA;
          if (!c.PortaRate) c.CurPeriod = noteA;
          // MAYBEWAIT
          if (c.NewStyleMacro === 0x00) {
            c.NewStyleMacro = 0xFF;
            break;
          } else {
            return;
          }
        }

        case 0x17: {
          // SetPeriod
          c.DestPeriod = x.w1;
          if (!c.PortaRate) c.CurPeriod = x.w1;
          break;
        }

        case 0x0B: {
          // Portamento
          c.PortaReset = x.b1;
          c.PortaTime = 1;
          if (!c.PortaRate) c.PortaPer = c.DestPeriod;
          c.PortaRate = toS16(x.w1);
          break;
        }

        case 0x0C: {
          // Vibrato
          c.VibTime = (c.VibReset = x.b1) >> 1;
          c.VibWidth = toS8(x.b3);
          c.VibFlag = 1;
          if (!c.PortaRate) {
            c.CurPeriod = c.DestPeriod;
            c.VibOffset = 0;
          }
          break;
        }

        case 0x0F: {
          // Envelope
          c.EnvReset = c.EnvTime = x.b2;
          c.EnvEndvol = toS8(x.b3);
          c.EnvRate = x.b1;
          break;
        }

        case 0x0A: {
          // Reset effects
          c.EnvReset = 0;
          c.VibReset = 0;
          c.PortaRate = 0;
          c.AddBeginTime = 0;
          break;
        }

        case 0x14: {
          // Wait key up
          if (!c.KeyUp) c.Loop = 0;
          if (c.Loop === 0) {
            c.Loop = -1;
            break;
          }
          if (c.Loop === -1) {
            c.Loop = x.b3 - 1;
          } else {
            c.Loop--;
          }
          c.MacroStep--;
          return;
        }

        case 0x15: {
          // Go sub
          c.ReturnPtr = c.MacroPtr;
          c.ReturnStep = c.MacroStep;
        }
        // fall through to Cont
        // eslint-disable-next-line no-fallthrough
        case 0x06: {
          // Cont (jump to macro)
          c.MacroNum = x.b1;
          c.MacroPtr = this.data!.macros[x.b1] || 0;
          c.MacroStep = x.w1;
          c.Loop = 0xFFFF;
          break;
        }

        case 0x16: {
          // Return sub
          c.MacroPtr = c.ReturnPtr;
          c.MacroStep = c.ReturnStep;
          break;
        }

        case 0x18: {
          // Sampleloop
          const offset = x.w1 & 0xFFFE;
          c.SaveAddr += offset;
          c.SaveLen -= offset >> 1;
          c.CurrLength = c.SaveLen;
          c.CurAddr = c.SaveAddr;
          break;
        }

        case 0x19: {
          // One-shot
          c.AddBeginTime = 0;
          c.SaveAddr = c.CurAddr = 0;
          c.SaveLen = c.CurrLength = 1;
          break;
        }

        case 0x20: {
          // Cue
          this.idb.Cue[x.b1 & 0x03] = x.w1;
          break;
        }

        // SID commands (0x22-0x29, 0x30) - mostly stubs
        case 0x22: {
          // SID setbeg (approximate: treat like SetBegin)
          c.AddBeginTime = 0;
          c.CurAddr = x.l;
          break;
        }
        case 0x23:
        case 0x24:
        case 0x25:
        case 0x26:
        case 0x27:
        case 0x28:
        case 0x29:
        case 0x30: {
          // SID commands - not implemented
          break;
        }

        case 0x31: {
          // Turrican 3 title - safely ignore
          break;
        }

        default: {
          // Unknown command
          break;
        }
      }
      // loop back (goto loop in C)
      continue;
    }
  }

  // --- DoEffects: process per-tick effects for a channel ---
  // Ported from DoEffects() in player.c
  private doEffects(c: Cdb): void {
    if (c.EfxRun < 0) return;
    if (!c.EfxRun) {
      c.EfxRun = 1;
      return;
    }

    // AddBegin vibrato
    if (c.AddBeginTime) {
      c.CurAddr += c.AddBegin;
      c.SaveAddr = c.CurAddr;
      c.AddBeginTime--;
      if (!c.AddBeginTime) {
        c.AddBegin = -c.AddBegin;
        c.AddBeginTime = c.AddBeginReset;
      }
    }

    // Vibrato
    if (c.VibReset) {
      let vibA = (c.VibOffset += c.VibWidth);
      vibA = (c.DestPeriod * (0x800 + vibA)) >> 11;
      if (!c.PortaRate) c.CurPeriod = vibA;
      if (!(--c.VibTime)) {
        c.VibTime = c.VibReset;
        c.VibWidth = -c.VibWidth;
      }
    }

    // Portamento
    if (c.PortaRate && (--c.PortaTime) === 0) {
      c.PortaTime = c.PortaReset;
      let portA = 0;
      if (c.PortaPer > c.DestPeriod) {
        portA = ((c.PortaPer * (256 - c.PortaRate)) - 128) >> 8;
        if (portA <= c.DestPeriod) c.PortaRate = 0;
      } else if (c.PortaPer < c.DestPeriod) {
        portA = (c.PortaPer * (256 + c.PortaRate)) >> 8;
        if (portA >= c.DestPeriod) c.PortaRate = 0;
      } else {
        c.PortaRate = 0;
      }
      if (!c.PortaRate) portA = c.DestPeriod;
      c.PortaPer = c.CurPeriod = portA;
    }

    // Envelope
    if (c.EnvReset && !(c.EnvTime--)) {
      c.EnvTime = c.EnvReset;
      if (c.CurVol > c.EnvEndvol) {
        if (c.CurVol < c.EnvRate) {
          c.EnvReset = 0;
        } else {
          c.CurVol -= c.EnvRate;
        }
        if (c.EnvEndvol > c.CurVol) c.EnvReset = 0;
      } else if (c.CurVol < c.EnvEndvol) {
        c.CurVol += c.EnvRate;
        if (c.EnvEndvol < c.CurVol) c.EnvReset = 0;
      }
      if (!c.EnvReset) {
        c.EnvReset = c.EnvTime = 0;
        c.CurVol = c.EnvEndvol;
      }
    }

    // Master volume fade
    if (this.mdb.FadeSlope && (--this.mdb.FadeTime) === 0) {
      this.mdb.FadeTime = this.mdb.FadeReset;
      this.mdb.MasterVol += this.mdb.FadeSlope;
      if (this.mdb.FadeDest === this.mdb.MasterVol) this.mdb.FadeSlope = 0;
    }
  }

  // --- DoMacro: process one channel's macro ---
  // Ported from DoMacro() in player.c
  private doMacro(cc: number): void {
    const c = this.cdb[cc];
    const hw = this.hdb[c.hwIdx];

    // SFX locking
    if (c.SfxLockTime >= 0) {
      c.SfxLockTime--;
    } else {
      c.SfxFlag = c.SfxPriority = 0;
    }

    const sfxA = c.SfxCode;
    if (sfxA) {
      c.SfxFlag = c.SfxCode = 0;
      this.notePort(sfxA);
      c.SfxFlag = c.SfxPriority;
    }

    const nRun = c.MacroRun;
    const nWait = c.MacroWait;
    c.MacroWait = c.MacroWait - 1;

    if (nRun && !nWait) {
      this.runMacro(c, cc);
    }

    this.doEffects(c);

    // Update hardware channel
    hw.delta = c.CurPeriod ? ((3579545 << 9) / ((c.CurPeriod * this.outRate) >> 5)) >>> 0 : 0;
    hw.SampleStart = c.SaveAddr;
    hw.SampleLength = c.SaveLen ? c.SaveLen << 1 : 131072;
    if ((hw.mode & 3) === 1) {
      hw.sbeg = hw.SampleStart;
      hw.slen = hw.SampleLength;
    }
    hw.vol = ((c.CurVol & 0xFF) * this.mdb.MasterVol) >> 6;
  }

  // --- DoAllMacros ---
  private doAllMacros(): void {
    this.doMacro(0);
    this.doMacro(1);
    this.doMacro(2);
    if (this.multimode) {
      this.doMacro(4);
      this.doMacro(5);
      this.doMacro(6);
      this.doMacro(7);
    }
    this.doMacro(3);
  }

  // --- ChannelOff ---
  private channelOff(i: number): void {
    const c = this.cdb[i & 0xF];
    if (!c.SfxFlag) {
      const hw = this.hdb[c.hwIdx];
      hw.mode = 0;
      c.AddBeginTime = 0;
      c.AddBeginReset = 0;
      c.MacroRun = 0;
      c.NewStyleMacro = 0xFF;
      c.SaveAddr = 0;
      c.CurVol = 0;
      hw.vol = 0;
      c.SaveLen = c.CurrLength = 1;
      hw.loop = this.loopOff;
      hw.cIdx = i & 0xF;
    }
  }

  // --- DoFade ---
  private doFade(sp: number, dv: number): void {
    this.mdb.FadeDest = dv;
    this.mdb.FadeTime = this.mdb.FadeReset = sp;
    if (!sp || this.mdb.MasterVol === sp) {
      this.mdb.MasterVol = dv;
      this.mdb.FadeSlope = 0;
      return;
    }
    this.mdb.FadeSlope = this.mdb.MasterVol > this.mdb.FadeDest ? -1 : 1;
  }

  // --- GetTrackStep: load next trackstep line ---
  // Ported from GetTrackStep() in player.c
  // The trackstep is an array of 8 U16 values per line.
  // We access it through editbuf, treating the area as 16-bit words.
  private getTrackStep(): void {
    if (!this.data) return;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Loop/end check (ported from C: loops variable check at top of GetTrackStep)
      // loops === 0 means infinite looping (browser default) — skip the check entirely.
      // loops > 0 is handled by the trackstep loop command (case 1 below).
      // loops < 0 means we've counted down past zero — stop the player.
      if (this.pdb.CurrPos === this.pdb.FirstPos && this.loops < 0) {
        this.mdb.PlayerEnable = 0;
        return;
      }

      // Read 8 words for the current trackstep position
      // Each trackstep line = 8 words = 16 bytes = 4 longs
      const baseWordIdx = this.pdb.CurrPos * 8;
      const l: number[] = [];
      for (let i = 0; i < 8; i++) {
        l.push(this.readTrackstepWord(baseWordIdx + i));
      }

      this.jiffies = 0;

      if (l[0] === 0xEFFE) {
        switch (l[1]) {
          case 0: // stop
            this.mdb.PlayerEnable = 0;
            return;

          case 1: {
            // trackstep loop command
            if (this.loops) {
              this.loops--;
              if (this.loops === 0) {
                this.mdb.PlayerEnable = 0;
                return;
              }
            }
            // C code: if(!(mdb.TrackLoop--)) - post-decrement
            {
              const oldTL = this.mdb.TrackLoop;
              this.mdb.TrackLoop--;
              if (oldTL === 0) {
                this.mdb.TrackLoop = -1;
                this.pdb.CurrPos++;
                continue;
              } else if (this.mdb.TrackLoop < 0) {
                this.mdb.TrackLoop = l[3];
              }
            }
            this.pdb.CurrPos = l[2];
            continue;
          }

          case 2: {
            // speed
            this.mdb.SpeedCnt = this.pdb.Prescale = l[2];
            {
              const bpmVal = l[3] & 0x1FF;
              if (!(l[3] & 0xF200) && bpmVal > 0xF) {
                this.mdb.CIASave = this.eClocks = Math.floor(0x1B51F8 / bpmVal);
              }
            }
            this.pdb.CurrPos++;
            continue;
          }

          case 3: {
            // timeshare
            // C code: x=l[3]; x=((char)x)<-0x20?-0x20:(char)x;
            // The (char) cast takes the LOW BYTE and sign-extends it.
            // e.g. l[3]=0x00EE → (char)0xEE = -18
            const tsX = l[3];
            if (!(tsX & 0x8000)) {
              let signedX = toS8(tsX & 0xFF);
              if (signedX < -0x20) signedX = -0x20;
              this.mdb.CIASave = this.eClocks = Math.floor((14318 * (signedX + 100)) / 100);
              this.multimode = 1;
            }
            this.pdb.CurrPos++;
            continue;
          }

          case 4: {
            // fade
            this.doFade(l[2] & 0xFF, l[3] & 0xFF);
            this.pdb.CurrPos++;
            continue;
          }

          default: {
            this.pdb.CurrPos++;
            continue;
          }
        }
      } else {
        // Normal trackstep line: load pattern pointers
        for (let i = 0; i < 8; i++) {
          const word = l[i];
          const pXpose = toS8(word & 0xFF);
          const pNum = (word >> 8) & 0xFF;
          this.pdb.p[i].PXpose = pXpose;
          if (pNum < 0x80) {
            this.pdb.p[i].PNum = pNum;
            this.pdb.p[i].PStep = 0;
            this.pdb.p[i].PWait = 0;
            this.pdb.p[i].PLoop = 0xFFFF;
            this.pdb.p[i].PAddr = this.data.patterns[pNum] || 0;
          } else {
            this.pdb.p[i].PNum = pNum;
          }
        }
        return;
      }
    }
  }

  // --- DoTrack: process one track's pattern ---
  // Ported from DoTrack() in player.c
  // Returns 1 if trackstep advanced, 0 otherwise
  // trackIndex is used for track-level muting: when a track is muted,
  // notePort() calls are skipped but timing/structural commands still run.
  private doTrack(p: Pdb, trackIndex: number): number {
    if (!this.data) return 0;
    const muted = this.trackMuted[trackIndex] ?? false;

    if (p.PNum === 0xFE) {
      p.PNum++;
      if (!muted) this.channelOff(p.PXpose);
      return 0;
    }
    if (!p.PAddr && p.PNum !== 0) return 0;
    if (p.PNum >= 0x90) return 0;
    if (p.PWait) {
      p.PWait--;
      return 0;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rawVal = this.readEditbuf(p.PAddr + p.PStep);
      p.PStep++;

      const x = new UNI(rawVal);
      const t = x.b0;

      if (t < 0xF0) {
        if ((t & 0xC0) === 0x80) {
          p.PWait = x.b3;
          x.b3 = 0;
        }
        x.b0 = (t + p.PXpose) & 0x3F;
        if ((t & 0xC0) === 0xC0) {
          x.b0 = x.b0 | 0xC0;
        }
        if (!muted) this.notePort(x.l);
        if ((t & 0xC0) === 0x80) {
          return 0;
        }
        continue;
      }

      switch (t & 0xF) {
        case 15: // NOP
          break;

        case 0: {
          // End
          p.PNum = 0xFF;
          this.pdb.CurrPos = (this.pdb.CurrPos === this.pdb.LastPos)
            ? this.pdb.FirstPos
            : this.pdb.CurrPos + 1;
          this.getTrackStep();
          return 1;
        }

        case 1: {
          // Loop
          if (p.PLoop === 0) {
            p.PLoop = 0xFFFF;
            break;
          } else if (p.PLoop === 0xFFFF) {
            p.PLoop = x.b1;
          }
          p.PLoop--;
          p.PStep = x.w1;
          break;
        }

        case 8: {
          // GsPt
          p.PRoAddr = p.PAddr;
          p.PRoStep = p.PStep;
        }
        // fall through to Cont
        // eslint-disable-next-line no-fallthrough
        case 2: {
          // Cont
          p.PAddr = this.data.patterns[x.b1] || 0;
          p.PStep = x.w1;
          break;
        }

        case 3: {
          // Wait
          p.PWait = x.b1;
          return 0;
        }

        case 14: {
          // StCu
          this.mdb.PlayPattFlag = 0;
        }
        // fall through to Stop
        // eslint-disable-next-line no-fallthrough
        case 4: {
          // Stop
          p.PNum = 0xFF;
          return 0;
        }

        case 5:  // Kup^
        case 6:  // Vibr
        case 7:  // Enve
        case 12: // Lock
          if (!muted) this.notePort(x.l);
          break;

        case 9: {
          // RoPt
          p.PAddr = p.PRoAddr;
          p.PStep = p.PRoStep;
          break;
        }

        case 10: {
          // Fade
          this.doFade(x.b1, x.b3);
          break;
        }

        case 13: {
          // Cue
          this.idb.Cue[x.b1 & 0x03] = x.w1;
          break;
        }

        case 11: {
          // PPat
          const trackIdx = x.b2 & 0x07;
          this.pdb.p[trackIdx].PNum = x.b1;
          this.pdb.p[trackIdx].PAddr = this.data.patterns[x.b1] || 0;
          this.pdb.p[trackIdx].PXpose = toS8(x.b3);
          this.pdb.p[trackIdx].PStep = 0;
          this.pdb.p[trackIdx].PWait = 0;
          this.pdb.p[trackIdx].PLoop = 0xFFFF;
          break;
        }
      }
    }
  }

  // --- DoTracks: advance all tracks ---
  private doTracks(): void {
    this.jiffies++;
    // C code: if (!mdb.SpeedCnt--) - post-decrement, enter if old value was 0
    const oldSpeedCnt = this.mdb.SpeedCnt;
    this.mdb.SpeedCnt--;
    if (oldSpeedCnt === 0) {
      this.mdb.SpeedCnt = this.pdb.Prescale;
      for (let x = 0; x < 8; x++) {
        if (this.doTrack(this.pdb.p[x], x)) {
          x = -1; // restart loop
          continue;
        }
      }
    }
  }

  // --- Public: main tick entry point ---
  // Called once per "jiffy" by the audio layer.
  // Ported from tfmxIrqIn() in player.c
  tfmxIrqIn(): void {
    if (!this.mdb.PlayerEnable) return;
    this.doAllMacros();
    if (this.mdb.CurrSong >= 0) this.doTracks();
  }

  // --- Public: initialize all state ---
  // Ported from AllOff() + TfmxInit() in player.c
  allOff(): void {
    this.mdb.PlayerEnable = 0;
    for (let x = 0; x < 8; x++) {
      const c = this.cdb[x];
      const hw = this.hdb[x];
      c.hwIdx = x;
      hw.cIdx = x;
      hw.mode = 0;
      c.MacroWait = 0;
      c.MacroRun = 0;
      c.SfxFlag = 0;
      c.CurVol = 0;
      c.SfxCode = 0;
      c.SaveAddr = 0;
      hw.vol = 0;
      c.Loop = -1;
      c.NewStyleMacro = 0xFF;
      c.SfxLockTime = -1;
      hw.sbeg = 0;
      hw.SampleStart = 0;
      hw.SampleLength = 2;
      hw.slen = 2;
      c.SaveLen = 2;
      hw.loop = this.loopOff;
    }
  }

  tfmxInit(): void {
    this.allOff();
    for (let x = 0; x < 8; x++) {
      this.hdb[x].cIdx = x;
      this.pdb.p[x].PNum = 0xFF;
      this.pdb.p[x].PAddr = 0;
      this.channelOff(x);
    }
  }

  // --- Public: start playing a song ---
  // Ported from StartSong() in player.c
  startSong(song: number, mode: number = 0): void {
    if (!this.data) return;

    this.mdb.PlayerEnable = 0;
    this.mdb.MasterVol = 0x40;
    this.mdb.FadeSlope = 0;
    this.mdb.TrackLoop = -1;
    this.mdb.PlayPattFlag = 0;
    this.mdb.CIASave = this.eClocks = DEFAULT_ECLOCKS;
    this.loops = 0; // Reset to infinite looping for each new song

    if (mode !== 2) {
      this.pdb.CurrPos = this.pdb.FirstPos = this.data.hdr.start[song];
      this.pdb.LastPos = this.data.hdr.end[song];
      const tempo = this.data.hdr.tempo[song];
      if (tempo >= 0x10) {
        this.mdb.CIASave = this.eClocks = Math.floor(0x1B51F8 / tempo);
        this.pdb.Prescale = 0;
      } else {
        this.pdb.Prescale = tempo;
      }
    }

    for (let x = 0; x < 8; x++) {
      this.pdb.p[x].PAddr = 0;
      this.pdb.p[x].PNum = 0xFF;
      this.pdb.p[x].PXpose = 0;
      this.pdb.p[x].PStep = 0;
    }

    if (mode !== 2) this.getTrackStep();

    this.mdb.SpeedCnt = 0;
    this.mdb.EndFlag = 0;
    this.mdb.PlayerEnable = 1;
    this.mdb.CurrSong = song;
  }

  // --- Public: check if player is enabled ---
  get isPlaying(): boolean {
    return this.mdb.PlayerEnable !== 0;
  }

  // --- Public: trigger a single macro for preview purposes ---
  // Sets up a note on channel 0, bypassing the track/pattern system.
  // The player must be enabled and ticking for the macro to execute.
  triggerMacro(macroNum: number, noteNum: number = 0x1E): void {
    if (!this.data || macroNum < 0 || macroNum >= this.data.numMacros) return;

    // Build a note command: note=noteNum, macro=macroNum, velocity=0xF, detune=0
    // Format: aa bb cv dd -> note, macro, (vel<<4)|channel, detune
    const noteCmd =
      ((noteNum & 0x3F) << 24) |
      ((macroNum & 0xFF) << 16) |
      (0xF0) | // velocity=0xF, channel=0
      0;        // detune=0

    this.notePort(noteCmd >>> 0);
  }

  // --- Public: enable the player for macro preview (no song) ---
  enableForPreview(): void {
    this.mdb.PlayerEnable = 1;
    this.mdb.CurrSong = -1; // prevent DoTracks from running
  }

  // --- Public: get current display state for the pattern view ---
  getDisplayState(): PlaybackDisplayState {
    if (!this.data) {
      return {
        currPos: 0,
        tracks: Array.from({ length: 8 }, () => ({
          patternNum: -1,
          currentStep: 0,
          active: false,
        })),
      };
    }

    const tracks: TrackDisplayState[] = [];
    for (let i = 0; i < 8; i++) {
      const p = this.pdb.p[i];
      // A track is actively processing if PNum < 0x90.
      // PNum < 0x80 = normal pattern, 0x80 = hold (keep running with new transpose).
      // The player engine (doTrack) continues processing for PNum 0x80-0x8F,
      // only returning early at PNum >= 0x90.
      const active = p.PNum < 0x90;

      let patternNum = -1;
      if (active) {
        // Reverse-lookup pattern number from PAddr
        for (let j = 0; j < this.data.patterns.length; j++) {
          if (this.data.patterns[j] === p.PAddr) {
            patternNum = j;
            break;
          }
        }
      }

      tracks.push({
        patternNum,
        currentStep: p.PStep > 0 ? p.PStep - 1 : 0,
        active: active && patternNum >= 0,
      });
    }

    return {
      currPos: this.pdb.CurrPos,
      tracks,
    };
  }
}

export interface TrackDisplayState {
  patternNum: number;
  currentStep: number;
  active: boolean;
}

export interface PlaybackDisplayState {
  currPos: number;
  tracks: TrackDisplayState[];
}

