# TFMX Player – Browser-Based Amiga Music Player

A TFMX music player written in pure TypeScript with a React frontend, using Vite as the build tool. TFMX is a music format created by Chris Hülsbeck for the Commodore Amiga, used in classic games like Turrican, R-Type, and many others.

## How It Works

### Overview

The player is a faithful port of the C reference implementation (`resource/tfmxplay-1.1.7/`) to TypeScript. It loads two binary Amiga files — an **MDAT** file (music data: sequences, patterns, macros) and an **SMPL** file (raw 8-bit signed PCM samples) — parses them, and plays them back in real time using the Web Audio API.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  React UI (PlayerUI.tsx)                            │
│  ┌─────────┐ ┌─────────┐ ┌──────┐ ┌──────────────┐ │
│  │Load MDAT│ │Load SMPL│ │ Play │ │ Prev/Next    │ │
│  └────┬────┘ └────┬────┘ └──┬───┘ │ Sub-Song     │ │
│       │           │         │     └──────┬───────┘ │
└───────┼───────────┼─────────┼────────────┼─────────┘
        │           │         │            │
        ▼           ▼         ▼            ▼
┌─────────────────────────────────────────────────────┐
│  TFMXAudio (Web Audio API bridge)                   │
│  - Owns AudioContext + ScriptProcessorNode          │
│  - Drives the player tick loop from audio callback  │
│  - Mixes 4/8 hardware channels → stereo output      │
└──────────────────────┬──────────────────────────────┘
                       │ calls tfmxIrqIn() per tick
                       ▼
┌─────────────────────────────────────────────────────┐
│  TFMXPlayer (core engine, ported from player.c)     │
│  - Trackstep sequencer (GetTrackStep / DoTracks)    │
│  - Pattern interpreter (DoTrack)                    │
│  - Macro interpreter (RunMacro – the big switch)    │
│  - Effects processor (DoEffects – vibrato, porta,   │
│    envelope, fade)                                  │
│  - Note dispatch (NotePort)                         │
└──────────────────────┬──────────────────────────────┘
                       │ reads from
                       ▼
┌─────────────────────────────────────────────────────┐
│  TFMXParser (binary file parser)                    │
│  - Parses MDAT header (magic, text, song table)     │
│  - Builds editbuf[] (pattern/macro data as int32)   │
│  - Resolves pattern & macro pointer tables          │
│  - Byte-swaps trackstep area                        │
│  - Loads SMPL as raw Int8Array                      │
└─────────────────────────────────────────────────────┘
```

### The TFMX Format

TFMX files come in pairs:
- **MDAT** (e.g. `mdat.world_1`) — contains the music data:
  - A 512-byte header with magic string, 240 bytes of text, and tables of 32 song start/end/tempo values
  - Trackstep data — the top-level sequencer that assigns patterns to channels
  - Pattern data — sequences of notes and commands per channel
  - Macro data — low-level voice programs that control DMA, samples, effects
- **SMPL** (e.g. `smpl.world_1`) — raw 8-bit signed PCM sample data referenced by macros

### Playback Pipeline

1. **File Loading**: The user loads MDAT and SMPL files via file input buttons. The `TFMXParser` reads the binary data using `DataView` with explicit big-endian interpretation (matching the Amiga's 68000 CPU byte order).

2. **Initialization**: `TFMXPlayer.startSong(n)` sets up the trackstep position, tempo, and initialises all 8 channel state machines.

3. **Audio Callback**: `TFMXAudio` creates an `AudioContext` with a `ScriptProcessorNode`. Every time the audio system needs samples (~every 2048 frames), the `onaudioprocess` callback fires:
   - It calculates how many player "jiffies" (ticks) fit into the requested sample count based on `eClocks` timing
   - For each tick, it calls `player.tfmxIrqIn()` which:
     - Runs all macro programs (advancing sample pointers, applying effects)
     - Advances the trackstep/pattern sequencer (loading new patterns, dispatching notes)
   - Between ticks, it mixes the 4 hardware channels into stereo using delta-based sample interpolation

4. **Mixing**: Each hardware channel (`Hdb`) maintains a sample pointer, length, volume, and playback delta (period-to-sample-rate ratio). The mixer reads signed 8-bit samples, applies volume scaling, and sums them into floating-point left/right output buffers with optional stereo panning and low-pass filtering.

### Key C-to-TypeScript Porting Details

- **UNI Union**: The C code accesses 32-bit values as individual bytes or 16-bit words via a union. The TypeScript `UNI` class provides `b0`/`b1`/`b2`/`b3` (byte) and `w0`/`w1` (word) accessors using bitwise operations.

- **Post-decrement Semantics**: Several critical C idioms like `if (!(c->Loop--))` rely on post-decrement (check original value, then decrement). These were carefully translated to preserve identical behavior.

- **Intentional Fall-throughs**: The C macro switch uses `goto` and case fall-throughs (e.g., `case 0x10` falls through to `case 0x05` for loop-key-up). These were preserved with explicit conditional `break` statements.

- **Signed/Unsigned Conversions**: Helper functions `toS8()` and `toS16()` convert unsigned byte/word values to signed, matching C's signed char/short casting behavior used extensively in the player.

- **Endianness**: All binary data is read as big-endian at parse time. The `editbuf` stores values in host order so the player engine can work with plain numbers.

## File Structure

```
app/src/
├── tfmx/
│   ├── types.ts          # TypeScript interfaces for all player state (Hdb, Mdb, Cdb, Pdb, etc.)
│   ├── constants.ts      # Note period lookup table, default timing constants
│   ├── TFMXParser.ts     # Binary file parser for MDAT + SMPL
│   ├── TFMXPlayer.ts     # Core player engine (port of player.c)
│   ├── TFMXAudio.ts      # Web Audio API integration and sample mixing
│   └── index.ts          # Public API exports
├── components/
│   ├── PlayerUI.tsx       # React UI with file inputs and transport controls
│   └── PlayerUI.css       # Dark theme styling
├── App.tsx                # Root React component
├── main.tsx               # Entry point
└── index.css              # Global styles
```

## Getting Started

```bash
cd app
npm install
npm run dev
```

Then open the browser, load an MDAT file and its corresponding SMPL file, and press Play.

## Test Files

Sample TFMX music files for Turrican 2 are available in `resource/Turrican_2/`. The naming convention is `mdat.<trackname>` and `smpl.<trackname>`.

## Reference Material

- **TFMX Format Specification**: `resource/tfmx-spec.txt`
- **C Reference Implementation**: `resource/tfmxplay-1.1.7/src/player.c` (core engine), `tfmxplay.c` (file loading), `audio.c` (SDL mixing)

## Known Limitations

- The `ScriptProcessorNode` used for audio output is deprecated but remains widely supported. A future improvement could migrate to `AudioWorklet` with `SharedArrayBuffer`.
- SID macro commands (`0x22`–`0x29`) from GemX are not implemented (matching the C reference's TODO state).
- Random play (`0x1B`) and random limit (`0x1E`) macro commands are not implemented (matching the C reference).
- The MD5-based game-specific hacks from the C reference (Danger Freak, Oops Up, Monkey Island, Z-Out) are not ported; these affect only a handful of specific MDAT files.
