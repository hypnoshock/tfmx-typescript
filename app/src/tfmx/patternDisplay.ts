/**
 * Pattern data decoding utilities for the tracker-style display.
 * Converts raw editbuf data into human-readable pattern entries.
 */

import type { TFMXData } from './types';
import { UNI } from './types';

// Note name lookup tables (from dump_pattern in tfmxplay.c)
const N1 = 'CCDDEFFGGAAB';
const N2 = ' # #  # # # ';

export type PatternEntryType = 'note' | 'note-wait' | 'porta' | 'command';

export interface PatternEntry {
  step: number;
  display: string;
  type: PatternEntryType;
  isEnd: boolean;
}

/**
 * Convert a TFMX note number to a display name like "C-3", "F#0" etc.
 * Only the lowest 6 bits are significant.
 */
function getNoteName(noteNum: number): string {
  const val = (noteNum & 0x3F) + 6;
  const oct = Math.floor(val / 12);
  const semi = val % 12;
  return N1[semi] + (N2[semi] === '#' ? '#' : '-') + oct;
}

function hex2(v: number): string {
  return (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Decode a single pattern entry (32-bit value) into a displayable form.
 *
 * Note format: aa bb cv dd
 *   aa = note number (00-EF)
 *   bb = macro number
 *   c  = relative volume (high nibble)
 *   v  = channel (low nibble)
 *   dd = depends on type:
 *     type 00 (aa < 0x80): detune
 *     type 10 (0x80 <= aa < 0xC0): wait count
 *     type 11 (0xC0 <= aa < 0xF0): portamento rate
 *
 * Command format: Fx bb cc dd (x = command 0-F)
 */
function decodeEntry(raw: number, step: number): PatternEntry {
  const x = new UNI(raw);
  const t = x.b0;

  if (t < 0xF0) {
    // Note or portamento
    const noteName = getNoteName(t);
    const macro = hex2(x.b1);
    const vol = ((x.b2 >> 4) & 0xF).toString(16).toUpperCase();

    if (t < 0x80) {
      // Immediate note (no wait), b3 = detune
      return { step, display: `${noteName} ${macro} ${vol}`, type: 'note', isEnd: false };
    } else if (t < 0xC0) {
      // Note with wait, b3 = wait count
      return { step, display: `${noteName} ${macro} ${vol}`, type: 'note-wait', isEnd: false };
    } else {
      // Portamento note, b3 = rate
      return { step, display: `${noteName} ${macro} ${vol}`, type: 'porta', isEnd: false };
    }
  }

  // Command (t >= 0xF0)
  const cmd = t & 0xF;
  let display: string;

  switch (cmd) {
    case 0:  display = 'End'; break;
    case 1:  display = `Loop ${hex2(x.b1)}`; break;
    case 2:  display = `Cont ${hex2(x.b1)}`; break;
    case 3:  display = `Wait ${hex2(x.b1)}`; break;
    case 4:  display = 'Stop'; break;
    case 5:  display = 'Kup^'; break;
    case 6:  display = `Vibr ${hex2(x.b1)}`; break;
    case 7:  display = `Enve ${hex2(x.b1)}`; break;
    case 8:  display = `GsPt ${hex2(x.b1)}`; break;
    case 9:  display = 'RoPt'; break;
    case 10: display = `Fade ${hex2(x.b1)}`; break;
    case 11: display = `PPat ${hex2(x.b1)}`; break;
    case 12: display = `Lock ${hex2(x.b1)}`; break;
    case 14: display = 'StCu'; break;
    case 15: display = 'NOP!'; break;
    default: display = `?${hex2(t)}`; break;
  }

  const isEnd = cmd === 0 || cmd === 4 || cmd === 14;
  return { step, display, type: 'command', isEnd };
}

/**
 * Decode a complete pattern into a list of display entries.
 * Reads from editbuf starting at the pattern's base address until
 * an End/Stop/StCu command is encountered (or a safety limit).
 */
export function decodePattern(data: TFMXData, patNum: number): PatternEntry[] {
  if (patNum < 0 || patNum >= data.numPatterns) return [];

  const entries: PatternEntry[] = [];
  const startAddr = data.patterns[patNum];
  const maxSteps = 512; // safety limit

  for (let step = 0; step < maxSteps; step++) {
    const idx = startAddr + step;
    if (idx < 0 || idx >= data.editbuf.length) break;

    const raw = data.editbuf[idx];
    const entry = decodeEntry(raw, step);
    entries.push(entry);
    if (entry.isEnd) break;
  }

  return entries;
}

/**
 * Decode all patterns in a module.
 * Returns an array indexed by pattern number.
 */
export function decodeAllPatterns(data: TFMXData): PatternEntry[][] {
  const result: PatternEntry[][] = [];
  for (let pat = 0; pat < data.numPatterns; pat++) {
    result.push(decodePattern(data, pat));
  }
  return result;
}

