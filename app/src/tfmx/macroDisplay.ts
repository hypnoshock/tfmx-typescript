/**
 * Macro data decoding utilities for the explorer display.
 * Converts raw editbuf data into human-readable macro entries.
 * Also extracts sample region information from macros.
 */

import type { TFMXData } from './types';
import { UNI, toS16 } from './types';

const MACRO_CMD_NAMES: Record<number, string> = {
  0x00: 'DMAoff+Rst',
  0x01: 'DMAon',
  0x02: 'SetBegin',
  0x03: 'SetLen',
  0x04: 'Wait',
  0x05: 'Loop',
  0x06: 'Cont',
  0x07: 'STOP',
  0x08: 'AddNote',
  0x09: 'SetNote',
  0x0A: 'Reset',
  0x0B: 'Portamento',
  0x0C: 'Vibrato',
  0x0D: 'AddVolume',
  0x0E: 'SetVolume',
  0x0F: 'Envelope',
  0x10: 'LoopKeyUp',
  0x11: 'AddBegin',
  0x12: 'AddLen',
  0x13: 'DMAoff',
  0x14: 'WaitKeyUp',
  0x15: 'GoSubmacro',
  0x16: 'Return',
  0x17: 'SetPeriod',
  0x18: 'SampleLoop',
  0x19: 'OneShot',
  0x1A: 'WaitOnDMA',
  0x1B: 'RandomPlay',
  0x1C: 'SplitKey',
  0x1D: 'SplitVol',
  0x1E: 'AddVol+Note',
  0x1F: 'SetPrevNote',
  0x20: 'Signal',
  0x21: 'PlayMacro',
  0x22: 'SID setbeg',
  0x23: 'SID setlen',
  0x24: 'SID op3 ofs',
  0x25: 'SID op3 frq',
  0x26: 'SID op2 ofs',
  0x27: 'SID op2 frq',
  0x28: 'SID op1',
  0x29: 'SID stop',
};

export interface MacroEntry {
  step: number;
  cmdCode: number;
  cmdName: string;
  params: string;
  display: string;
  isEnd: boolean;
}

export interface SampleInfo {
  /** Index in the deduplicated sample list */
  index: number;
  /** Byte offset into the sample buffer */
  address: number;
  /** Length in bytes */
  lengthBytes: number;
  /** Which macro(s) reference this sample */
  macroNums: number[];
}

function hex2(v: number): string {
  return (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
}

function hex4(v: number): string {
  return (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function hex6(v: number): string {
  return (v & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

/**
 * Decode a single macro command into a displayable form.
 */
function decodeMacroEntry(raw: number, step: number): MacroEntry {
  const x = new UNI(raw);
  const a = x.b0;
  x.b0 = 0; // clear the command byte from the UNI for param extraction

  const cmdName = MACRO_CMD_NAMES[a] ?? `??? (${hex2(a)})`;
  let params: string;

  switch (a) {
    case 0x02: // SetBegin - aaaaaa (24-bit address)
      params = hex6(x.l);
      break;
    case 0x03: // SetLen - ..xxxx (word count)
      params = hex4(x.w1);
      break;
    case 0x04: // Wait - ..xxxx
      params = hex4(x.w1);
      break;
    case 0x05: // Loop - xx/xxxx
    case 0x10: // LoopKeyUp - xx/xxxx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x06: // Cont - xx/xxxx
    case 0x15: // GoSubmacro - xx/xxxx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x08: // AddNote - xx/xxxx (note/detune)
    case 0x09: // SetNote - xx/xxxx
    case 0x1F: // SetPrevNote - xx/xxxx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x0B: // Portamento - xx/../xx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x0C: // Vibrato - xx/../xx
      params = `${hex2(x.b1)}/${hex2(x.b3)}`;
      break;
    case 0x0D: // AddVolume - ....xx
    case 0x0E: // SetVolume - ....xx
      params = hex2(x.b3);
      break;
    case 0x0F: // Envelope - xx/xx/xx
      params = `${hex2(x.b1)}/${hex2(x.b2)}/${hex2(x.b3)}`;
      break;
    case 0x11: // AddBegin - xx/xxxx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x12: // AddLen - ..xxxx
      params = hex4(x.w1);
      break;
    case 0x14: // WaitKeyUp - ....xx
      params = hex2(x.b3);
      break;
    case 0x17: // SetPeriod - ..xxxx
      params = hex4(x.w1);
      break;
    case 0x18: // SampleLoop - ..xxxx
      params = hex4(x.w1);
      break;
    case 0x1A: // WaitOnDMA - ..xxxx
      params = hex4(x.w1);
      break;
    case 0x1C: // SplitKey - xx/xxxx
    case 0x1D: // SplitVol - xx/xxxx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x20: // Signal - xx/xxxx
      params = `${hex2(x.b1)}/${hex4(x.w1)}`;
      break;
    case 0x21: // PlayMacro - xx/.x/xx
      params = `${hex2(x.b1)}/${hex2(x.b2)}/${hex2(x.b3)}`;
      break;
    case 0x00: // DMAoff+Reset
    case 0x13: // DMAoff
      params = `${hex2(x.b1)}/${hex2(x.b2)}/${hex2(x.b3)}`;
      break;
    case 0x01: // DMAon
    case 0x07: // STOP
    case 0x0A: // Reset
    case 0x16: // Return
    case 0x19: // OneShot
      params = '';
      break;
    default:
      params = `${hex2(x.b1)} ${hex4(x.w1)}`;
      break;
  }

  const display = params ? `${cmdName} ${params}` : cmdName;
  const isEnd = a === 0x07;

  return { step, cmdCode: a, cmdName, params, display, isEnd };
}

/**
 * Decode a complete macro into a list of display entries.
 */
export function decodeMacro(data: TFMXData, macroNum: number): MacroEntry[] {
  if (macroNum < 0 || macroNum >= data.numMacros) return [];

  const entries: MacroEntry[] = [];
  const startAddr = data.macros[macroNum];
  const maxSteps = 512; // safety limit

  for (let step = 0; step < maxSteps; step++) {
    const idx = startAddr + step;
    if (idx < 0 || idx >= data.editbuf.length) break;

    const raw = data.editbuf[idx];
    const entry = decodeMacroEntry(raw, step);
    entries.push(entry);
    if (entry.isEnd) break;
  }

  return entries;
}

/**
 * Decode all macros in a module.
 */
export function decodeAllMacros(data: TFMXData): MacroEntry[][] {
  const result: MacroEntry[][] = [];
  for (let mac = 0; mac < data.numMacros; mac++) {
    result.push(decodeMacro(data, mac));
  }
  return result;
}

/**
 * Extract unique sample regions from all macros.
 * Scans each macro for SetBegin (0x02) + SetLen (0x03) pairs to identify
 * the sample data regions.
 */
export function extractSamples(data: TFMXData): SampleInfo[] {
  const regionMap = new Map<string, SampleInfo>();
  let nextIdx = 0;

  for (let macNum = 0; macNum < data.numMacros; macNum++) {
    const startAddr = data.macros[macNum];
    const maxSteps = 512;
    let currentAddress = -1;

    for (let step = 0; step < maxSteps; step++) {
      const idx = startAddr + step;
      if (idx < 0 || idx >= data.editbuf.length) break;

      const raw = data.editbuf[idx];
      const x = new UNI(raw);
      const cmd = x.b0;
      x.b0 = 0;

      if (cmd === 0x02) {
        // SetBegin - 24-bit address
        currentAddress = x.l & 0xFFFFFF;
      } else if (cmd === 0x03 && currentAddress >= 0) {
        // SetLen - word count (each word = 2 bytes)
        const lengthBytes = x.w1 * 2;
        if (lengthBytes > 0 && currentAddress + lengthBytes <= data.smplbuf.length) {
          const key = `${currentAddress}:${lengthBytes}`;
          const existing = regionMap.get(key);
          if (existing) {
            if (!existing.macroNums.includes(macNum)) {
              existing.macroNums.push(macNum);
            }
          } else {
            regionMap.set(key, {
              index: nextIdx++,
              address: currentAddress,
              lengthBytes,
              macroNums: [macNum],
            });
          }
        }
        currentAddress = -1;
      } else if (cmd === 0x07) {
        // STOP - end of macro
        break;
      }
    }
  }

  return Array.from(regionMap.values()).sort((a, b) => a.address - b.address);
}

/**
 * Convert a sample region from signed 8-bit to a Float32Array for Web Audio.
 */
export function sampleToFloat32(data: TFMXData, sample: SampleInfo): Float32Array {
  const out = new Float32Array(sample.lengthBytes);
  for (let i = 0; i < sample.lengthBytes; i++) {
    const byteVal = data.smplbuf[sample.address + i] ?? 0;
    out[i] = byteVal / 128.0;
  }
  return out;
}

