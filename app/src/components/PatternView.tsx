import { useMemo, useCallback } from 'react';
import type { PatternEntry } from '../tfmx/patternDisplay';
import type { PlaybackDisplayState } from '../tfmx/TFMXPlayer';
import './PatternView.css';

const VISIBLE_ROWS = 17;
const ROW_HEIGHT = 18;
const CENTER_ROW = Math.floor(VISIBLE_ROWS / 2);
const VIEW_HEIGHT = VISIBLE_ROWS * ROW_HEIGHT;
const NUM_CHANNELS = 8;
const EMPTY_VOLUMES = Array(NUM_CHANNELS).fill(0);

// Channel indicator color palette (one hue per channel)
const CHANNEL_COLORS = [
  [255,  80,  80],  // ch0 - red
  [255, 160,  50],  // ch1 - orange
  [255, 230,  60],  // ch2 - yellow
  [ 80, 220,  80],  // ch3 - green
  [ 60, 180, 255],  // ch4 - blue
  [160, 100, 255],  // ch5 - purple
  [255, 100, 200],  // ch6 - pink
  [255, 255, 255],  // ch7 - white
];

interface PatternViewProps {
  decodedPatterns: PatternEntry[][];
  displayState: PlaybackDisplayState;
  trackMuted?: boolean[];
  onToggleMute?: (track: number) => void;
}

export function PatternView({ decodedPatterns, displayState, trackMuted, onToggleMute }: PatternViewProps) {
  const numTracks = 8;

  return (
    <div className="pattern-view">
      <div className="pattern-pos">
        Pos: {displayState.currPos.toString(16).toUpperCase().padStart(4, '0')}
      </div>
      <div className="pattern-grid">
        {Array.from({ length: numTracks }, (_, trackIdx) => {
          const track = displayState.tracks[trackIdx];
          const patData =
            track?.active && track.patternNum >= 0 && track.patternNum < decodedPatterns.length
              ? decodedPatterns[track.patternNum]
              : [];
          const currentStep = track?.active ? track.currentStep : -1;

          return (
            <TrackColumn
              key={trackIdx}
              trackIdx={trackIdx}
              patternNum={track?.patternNum ?? -1}
              entries={patData}
              currentStep={currentStep}
              active={track?.active ?? false}
              muted={trackMuted?.[trackIdx] ?? false}
              onToggleMute={onToggleMute}
              channelVolumes={track?.channelVolumes ?? EMPTY_VOLUMES}
            />
          );
        })}
      </div>
    </div>
  );
}

function TrackColumn({
  trackIdx,
  patternNum,
  entries,
  currentStep,
  active,
  muted,
  onToggleMute,
  channelVolumes,
}: {
  trackIdx: number;
  patternNum: number;
  entries: PatternEntry[];
  currentStep: number;
  active: boolean;
  muted: boolean;
  onToggleMute?: (channel: number) => void;
  channelVolumes: number[];
}) {
  // Calculate translateY to center the current step in the viewport
  const translateY = useMemo(() => {
    if (!active || currentStep < 0) return CENTER_ROW * ROW_HEIGHT;
    return -(currentStep * ROW_HEIGHT) + CENTER_ROW * ROW_HEIGHT;
  }, [active, currentStep]);

  const handleMuteClick = useCallback(() => {
    onToggleMute?.(trackIdx);
  }, [onToggleMute, trackIdx]);

  const headerText = active
    ? `Trk ${trackIdx} [${patternNum.toString(16).toUpperCase().padStart(2, '0')}]`
    : `Trk ${trackIdx}`;

  return (
    <div className={`track-column ${muted ? 'muted' : ''}`}>
      <div className={`track-header ${!active ? 'inactive' : ''}`}>
        <span className="track-header-text">{headerText}</span>
        <button
          className={`mute-btn ${muted ? 'muted' : ''}`}
          onClick={handleMuteClick}
          title={muted ? `Unmute track ${trackIdx}` : `Mute track ${trackIdx}`}
        >
          {muted ? 'M' : 'M'}
        </button>
      </div>
      <div className="channel-indicators">
        {Array.from({ length: NUM_CHANNELS }, (_, ch) => {
          const vol = channelVolumes[ch] ?? 0;
          // Normalize volume 0-64 to 0-1
          const intensity = Math.min(vol / 0x40, 1);
          const [r, g, b] = CHANNEL_COLORS[ch];
          const bg = intensity > 0
            ? `rgba(${r}, ${g}, ${b}, ${0.15 + intensity * 0.85})`
            : undefined;
          return (
            <div
              key={ch}
              className={`ch-dot ${intensity > 0 ? 'active' : ''}`}
              style={bg ? { backgroundColor: bg, boxShadow: `0 0 ${2 + intensity * 4}px rgba(${r}, ${g}, ${b}, ${intensity * 0.6})` } : undefined}
              title={`Ch ${ch}: ${vol}`}
            />
          );
        })}
      </div>
      <div className="track-viewport" style={{ height: VIEW_HEIGHT }}>
        {/* Cursor line at the center of the viewport */}
        <div
          className="track-cursor"
          style={{ top: CENTER_ROW * ROW_HEIGHT, height: ROW_HEIGHT }}
        />
        {active && entries.length > 0 ? (
          <div
            className="track-content"
            style={{ transform: `translateY(${translateY}px)` }}
          >
            {entries.map((entry, i) => (
              <div
                key={i}
                className={`pattern-row ${entry.type} ${i === currentStep ? 'current' : ''}`}
                style={{ height: ROW_HEIGHT }}
              >
                <span className="step-num">
                  {entry.step.toString(16).toUpperCase().padStart(2, '0')}
                </span>
                <span className="row-data">{entry.display}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="track-empty">---</div>
        )}
      </div>
    </div>
  );
}

