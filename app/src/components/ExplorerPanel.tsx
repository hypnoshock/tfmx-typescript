import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { TFMXData } from '../tfmx';
import type { TFMXAudio } from '../tfmx';
import type { MacroEntry, SampleInfo } from '../tfmx/macroDisplay';
import { decodeAllMacros, extractSamples, sampleToFloat32 } from '../tfmx/macroDisplay';
import './ExplorerPanel.css';

type Tab = 'samples' | 'macros';

interface ExplorerPanelProps {
  data: TFMXData;
  audio: TFMXAudio;
}

export function ExplorerPanel({ data, audio }: ExplorerPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('samples');

  const decodedMacros = useMemo(() => decodeAllMacros(data), [data]);
  const samples = useMemo(() => extractSamples(data), [data]);

  return (
    <div className="explorer-panel">
      <div className="explorer-tabs">
        <button
          className={`explorer-tab ${activeTab === 'samples' ? 'active' : ''}`}
          onClick={() => setActiveTab('samples')}
        >
          Samples ({samples.length})
        </button>
        <button
          className={`explorer-tab ${activeTab === 'macros' ? 'active' : ''}`}
          onClick={() => setActiveTab('macros')}
        >
          Macros ({data.numMacros})
        </button>
      </div>
      <div className="explorer-content">
        {activeTab === 'samples' ? (
          <SamplesTab data={data} audio={audio} samples={samples} />
        ) : (
          <MacrosTab data={data} audio={audio} decodedMacros={decodedMacros} />
        )}
      </div>
    </div>
  );
}

/* ========================================================================= */
/* Samples Tab                                                               */
/* ========================================================================= */

function SamplesTab({
  data,
  audio,
  samples,
}: {
  data: TFMXData;
  audio: TFMXAudio;
  samples: SampleInfo[];
}) {
  const handlePlay = useCallback(
    (sample: SampleInfo) => {
      const floatData = sampleToFloat32(data, sample);
      // Amiga base sample rate ≈ 16574 Hz (PAL C-3 period 0x12F)
      // Play at half speed (8287 Hz) for a more natural pitch
      audio.playSample(floatData, 8287);
    },
    [data, audio],
  );

  if (samples.length === 0) {
    return <div className="explorer-empty">No samples found in module</div>;
  }

  return (
    <div className="sample-list">
      {samples.map((sample) => (
        <SampleRow key={sample.index} sample={sample} data={data} onPlay={handlePlay} />
      ))}
    </div>
  );
}

function SampleRow({
  sample,
  data,
  onPlay,
}: {
  sample: SampleInfo;
  data: TFMXData;
  onPlay: (s: SampleInfo) => void;
}) {
  return (
    <div className="sample-item">
      <button
        className="sample-play-btn"
        onClick={() => onPlay(sample)}
        title="Play sample"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      <div className="sample-info">
        <div className="sample-name">
          Sample {sample.index.toString().padStart(2, '0')}
        </div>
        <div className="sample-detail">
          Addr: {sample.address.toString(16).toUpperCase().padStart(6, '0')}
          {' | '}Len: {sample.lengthBytes} bytes
          {' | '}Macro: {sample.macroNums.map((m) => m.toString(16).toUpperCase().padStart(2, '0')).join(', ')}
        </div>
      </div>
      <MiniWaveform data={data} sample={sample} />
    </div>
  );
}

/**
 * Tiny waveform visualization of a sample.
 */
function MiniWaveform({ data, sample }: { data: TFMXData; sample: SampleInfo }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(108, 99, 255, 0.5)';
    ctx.lineWidth = 1;

    // Draw center line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(42, 42, 62, 0.8)';
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // Draw waveform
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(108, 99, 255, 0.6)';
    const step = Math.max(1, Math.floor(sample.lengthBytes / w));
    for (let i = 0; i < w; i++) {
      const sampleIdx = sample.address + i * step;
      if (sampleIdx >= data.smplbuf.length) break;
      const val = data.smplbuf[sampleIdx] / 128.0;
      const y = mid - val * (mid - 1);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }, [data, sample]);

  return (
    <canvas
      ref={canvasRef}
      className="sample-waveform"
      width={80}
      height={28}
    />
  );
}

/* ========================================================================= */
/* Macros Tab                                                                */
/* ========================================================================= */

function MacrosTab({
  data,
  audio,
  decodedMacros,
}: {
  data: TFMXData;
  audio: TFMXAudio;
  decodedMacros: MacroEntry[][];
}) {
  const [selectedMacro, setSelectedMacro] = useState(0);

  const entries = decodedMacros[selectedMacro] ?? [];

  const handleTrigger = useCallback(() => {
    audio.triggerMacro(selectedMacro);
  }, [audio, selectedMacro]);

  if (data.numMacros === 0) {
    return <div className="explorer-empty">No macros found in module</div>;
  }

  return (
    <div className="macro-panel">
      <div className="macro-selector">
        <label htmlFor="macro-select">Macro:</label>
        <select
          id="macro-select"
          className="macro-select"
          value={selectedMacro}
          onChange={(e) => setSelectedMacro(Number(e.target.value))}
        >
          {Array.from({ length: data.numMacros }, (_, i) => (
            <option key={i} value={i}>
              {i.toString(16).toUpperCase().padStart(2, '0')} — {decodedMacros[i]?.length ?? 0} steps
            </option>
          ))}
        </select>
        <button className="macro-trigger-btn" onClick={handleTrigger} title="Play this macro at middle C">
          ▶ Play
        </button>
      </div>
      <div className="macro-commands">
        {entries.map((entry) => (
          <MacroCommandRow key={entry.step} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function MacroCommandRow({ entry }: { entry: MacroEntry }) {
  // Color-code by command category
  let nameClass = 'macro-cmd-name';
  if (entry.cmdCode === 0x02 || entry.cmdCode === 0x03 || entry.cmdCode === 0x18) {
    nameClass += ' cmd-sample'; // sample-related
  } else if (
    entry.cmdCode === 0x08 ||
    entry.cmdCode === 0x09 ||
    entry.cmdCode === 0x1F ||
    entry.cmdCode === 0x17
  ) {
    nameClass += ' cmd-note'; // note/frequency
  } else if (
    entry.cmdCode === 0x00 ||
    entry.cmdCode === 0x01 ||
    entry.cmdCode === 0x13
  ) {
    nameClass += ' cmd-dma'; // DMA control
  }

  return (
    <div className={`macro-cmd-row ${entry.isEnd ? 'is-end' : ''}`}>
      <span className="macro-cmd-step">
        {entry.step.toString(16).toUpperCase().padStart(2, '0')}
      </span>
      <span className="macro-cmd-code">
        {entry.cmdCode.toString(16).toUpperCase().padStart(2, '0')}
      </span>
      <span className={nameClass}>{entry.cmdName}</span>
      <span className="macro-cmd-params">{entry.params}</span>
    </div>
  );
}

