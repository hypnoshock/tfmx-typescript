import { useMemo } from 'react';
import type { PatternEntry } from '../tfmx/patternDisplay';
import type { PlaybackDisplayState } from '../tfmx/TFMXPlayer';
import './PatternView.css';

const VISIBLE_ROWS = 17;
const ROW_HEIGHT = 18;
const CENTER_ROW = Math.floor(VISIBLE_ROWS / 2);
const VIEW_HEIGHT = VISIBLE_ROWS * ROW_HEIGHT;

interface PatternViewProps {
  decodedPatterns: PatternEntry[][];
  displayState: PlaybackDisplayState;
}

export function PatternView({ decodedPatterns, displayState }: PatternViewProps) {
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
}: {
  trackIdx: number;
  patternNum: number;
  entries: PatternEntry[];
  currentStep: number;
  active: boolean;
}) {
  // Calculate translateY to center the current step in the viewport
  const translateY = useMemo(() => {
    if (!active || currentStep < 0) return CENTER_ROW * ROW_HEIGHT;
    return -(currentStep * ROW_HEIGHT) + CENTER_ROW * ROW_HEIGHT;
  }, [active, currentStep]);

  const headerText = active
    ? `Trk ${trackIdx} [${patternNum.toString(16).toUpperCase().padStart(2, '0')}]`
    : `Trk ${trackIdx}`;

  return (
    <div className="track-column">
      <div className={`track-header ${!active ? 'inactive' : ''}`}>{headerText}</div>
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

