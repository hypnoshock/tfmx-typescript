/**
 * TFMX Parser
 * Ported from load_tfmx() in tfmxplay.c
 *
 * Parses MDAT (song data) and SMPL (sample data) binary files
 * into a TFMXData structure ready for the player engine.
 */

import { md5 } from 'js-md5';
import type { Hdr, TFMXData } from './types';
import { HEADER_SIZE, TFMX_MAGIC_STRINGS } from './constants';

/**
 * Parse an MDAT ArrayBuffer and SMPL ArrayBuffer into TFMXData.
 */
export function parseTFMX(mdatBuffer: ArrayBuffer, smplBuffer: ArrayBuffer): TFMXData {
  // Calculate MD5 hash of MDAT file for automatic module detection
  const mdatHash = md5(mdatBuffer);
  const mdatView = new DataView(mdatBuffer);
  const mdatBytes = new Uint8Array(mdatBuffer);

  // --- Parse Header (first 512 bytes) ---
  const hdr = parseHeader(mdatView, mdatBytes);

  // --- Build editbuf from data after header ---
  // The C code reads 32-bit words starting at offset 0x200 into editbuf[]
  const dataOffset = HEADER_SIZE;
  const dataLen = mdatBuffer.byteLength - dataOffset;
  const numWords = Math.floor(dataLen / 4);

  // We store the raw big-endian 32-bit words. The player will ntohl them on access.
  // Actually, looking at the C code, editbuf stores the raw file data and ntohl is
  // done at access time in RunMacro, DoTrack etc. We replicate this by storing
  // the big-endian values and converting when reading.
  const editbuf = new Int32Array(numWords + 1);
  for (let i = 0; i < numWords; i++) {
    editbuf[i] = mdatView.getInt32(dataOffset + i * 4, false); // big-endian
  }
  editbuf[numWords] = -1; // sentinel

  const mlen = numWords;

  // --- Resolve trackstart, pattstart, macrostart ---
  // These are stored at fixed offsets in the header.
  // Offset $1D0 in the file = three longs: trackstart, pattstart, macrostart
  // In the Hdr struct they are at bytes 0x1D0-0x1DB of the file.
  // The C code reads them as part of struct Hdr and then converts:
  //   if null -> use fixed defaults
  //   else -> (ntohl(value) - 0x200) >> 2  (convert file offset to editbuf index)

  let trackstart: number;
  let pattstart: number;
  let macrostart: number;

  const rawTrackstart = mdatView.getUint32(0x1D0, false);
  const rawPattstart = mdatView.getUint32(0x1D4, false);
  const rawMacrostart = mdatView.getUint32(0x1D8, false);

  if (rawTrackstart === 0) {
    trackstart = 0x180; // 0x600 / 4 = 0x180 (editbuf index for unpacked)
  } else {
    trackstart = (rawTrackstart - 0x200) >> 2;
  }

  if (rawPattstart === 0) {
    pattstart = 0x80;  // 0x200 / 4 = 0x80 -> wait, 0x400/4 = 0x100... 
    // C code: hdr.pattstart=0x80, which is (0x400-0x200)/4=0x80. Actually:
    // The C code says: if (!hdr.pattstart) hdr.pattstart=0x80;
    // 0x80 * 4 + 0x200 = 0x400. So pattern pointers at file offset 0x400.
    pattstart = 0x80;
  } else {
    pattstart = (rawPattstart - 0x200) >> 2;
  }

  if (rawMacrostart === 0) {
    macrostart = 0x100; // 0x200 + 0x100*4 = 0x600. C code says 0x100.
    macrostart = 0x100;
  } else {
    macrostart = (rawMacrostart - 0x200) >> 2;
  }

  hdr.trackstart = trackstart;
  hdr.pattstart = pattstart;
  hdr.macrostart = macrostart;

  // --- Resolve macro pointer table ---
  // macros[] is a table of offsets. Each entry is a file offset that we convert
  // to an editbuf index. The C code:
  //   z = hdr.macrostart
  //   macros = &editbuf[z]
  //   for each entry: y = (ntohl(editbuf[z]) - 0x200); editbuf[z] = y >> 2
  const macros: number[] = [];
  let z = macrostart;
  let numMacros = 0;
  for (let i = 0; i < 128; i++) {
    // editbuf already has big-endian-converted values (we stored them as getInt32 big-endian)
    // But wait - the C code reads editbuf as raw bytes and then calls ntohl.
    // We already read with getInt32(big-endian) so our values ARE host-order.
    // The C code does: y = (ntohl(editbuf[z]) - 0x200)
    // Since we already converted from big-endian, we just do: y = (editbuf[z] - 0x200)
    // HOWEVER: the C code stores the editbuf as raw bytes (no conversion) and ntohl's on access.
    // We need to match that. Let me re-examine...
    //
    // In the C code:
    // - editbuf is filled with fread (raw big-endian bytes from file)
    // - In load_tfmx: ntohl(editbuf[z]) converts from big-endian to host
    // - Then editbuf[z] = y>>2 stores the HOST-order index back
    // - In player: ntohl(editbuf[...]) is used to read pattern/macro data
    //
    // So editbuf is a MIX: pointer tables are in host order, data is in big-endian.
    // 
    // For our TypeScript port, let's store everything in host order (already converted)
    // since we used getInt32(big-endian). The pointer resolution below will convert
    // the entries in-place just like the C code does.

    const raw = editbuf[z];
    const y = raw - 0x200;
    if ((y & 3) !== 0 || (y >> 2) > mlen) {
      break;
    }
    editbuf[z] = y >> 2;
    macros.push(y >> 2);
    z++;
    numMacros++;
  }

  // --- Resolve pattern pointer table ---
  const patterns: number[] = [];
  z = pattstart;
  let numPatterns = 0;
  for (let i = 0; i < 128; i++) {
    const raw = editbuf[z];
    const y = raw - 0x200;
    if ((y & 3) !== 0 || (y >> 2) > mlen) {
      break;
    }
    editbuf[z] = y >> 2;
    patterns.push(y >> 2);
    z++;
    numPatterns++;
  }

  // --- Byte-swap trackstep words ---
  // The C code ntohs's the trackstep area (which is 16-bit words).
  // Since we already loaded editbuf as big-endian int32s, the 16-bit words
  // within each 32-bit word are already in the correct order.
  // The C code operates on U16* pointers over the trackstep area.
  // Our editbuf stores 32-bit values. The trackstep is read as 16-bit words
  // in GetTrackStep (via U16* cast). We need to handle this correctly.
  //
  // In the C code, the trackstep ntohs loop converts the raw big-endian 16-bit
  // words to host order IN PLACE. Since we read the 32-bit words in big-endian,
  // the 16-bit sub-words are already correct. The C code's GetTrackStep reads
  // them as U16* which on little-endian needs the swap. Since we store everything
  // already converted, we're fine.
  //
  // HOWEVER: the trackstep is accessed as U16* array, so from our Int32Array
  // we need a helper to read 16-bit values. Let's create a Uint16 view of the
  // relevant section. Actually, it's easier to just store the trackstep words
  // separately or handle the 16-bit access in the player.
  //
  // For simplicity, since the player accesses trackstep as U16*, let's compute
  // the number of tracksteps and note that in the player we'll extract 16-bit
  // values from the 32-bit editbuf words.

  const numTracksteps = patterns[0] !== undefined
    ? (patterns[0] - trackstart) >> 2
    : 0;

  // --- Load sample data ---
  const smplbuf = new Int8Array(smplBuffer);

  return {
    hdr,
    editbuf,
    smplbuf,
    patterns,
    macros,
    numPatterns,
    numMacros,
    numTracksteps,
    mdatHash,
  };
}

/**
 * Parse the 512-byte MDAT header.
 */
function parseHeader(view: DataView, bytes: Uint8Array): Hdr {
  // Magic: first 10 bytes
  const magicBytes = bytes.slice(0, 10);
  const magic = String.fromCharCode(...magicBytes);

  // Validate magic
  let valid = false;
  for (const m of TFMX_MAGIC_STRINGS) {
    if (magic.startsWith(m)) {
      valid = true;
      break;
    }
  }
  if (!valid) {
    throw new Error(`Not a TFMX file. Magic: "${magic}"`);
  }

  // Text area: 6 x 40 chars starting at offset 16 (0x10)
  const text: string[] = [];
  for (let i = 0; i < 6; i++) {
    const offset = 0x10 + i * 40;
    const textBytes = bytes.slice(offset, offset + 40);
    text.push(String.fromCharCode(...textBytes));
  }

  // Song start positions: 32 x U16 at offset 0x100
  const start: number[] = [];
  for (let i = 0; i < 32; i++) {
    start.push(view.getUint16(0x100 + i * 2, false));
  }

  // Song end positions: 32 x U16 at offset 0x140
  const end: number[] = [];
  for (let i = 0; i < 32; i++) {
    end.push(view.getUint16(0x140 + i * 2, false));
  }

  // Tempo values: 32 x U16 at offset 0x180
  const tempo: number[] = [];
  for (let i = 0; i < 32; i++) {
    tempo.push(view.getUint16(0x180 + i * 2, false));
  }

  return {
    magic,
    text,
    start,
    end,
    tempo,
    trackstart: 0,
    pattstart: 0,
    macrostart: 0,
  };
}

/**
 * Count how many valid sub-songs exist in the header.
 */
export function countSubSongs(hdr: Hdr): number {
  let count = 0;
  for (let i = 0; i < 32; i++) {
    if (hdr.end[i] > 0) {
      count = i + 1;
    }
  }
  return count;
}

