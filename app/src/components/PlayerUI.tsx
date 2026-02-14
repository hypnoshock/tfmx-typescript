import { useState, useRef, useCallback, useEffect } from 'react';
import { TFMXAudio, parseTFMX, countSubSongs, decodeAllPatterns } from '../tfmx';
import type { TFMXData, PatternEntry, PlaybackDisplayState } from '../tfmx';
import { PatternView } from './PatternView';
import { ExplorerPanel } from './ExplorerPanel';
import './PlayerUI.css';

export function PlayerUI() {
  const audioRef = useRef<TFMXAudio | null>(null);
  const [data, setData] = useState<TFMXData | null>(null);
  const [songNum, setSongNum] = useState(0);
  const [totalSongs, setTotalSongs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [songText, setSongText] = useState<string[]>([]);
  const [mdatFile, setMdatFile] = useState<File | null>(null);
  const [smplFile, setSmplFile] = useState<File | null>(null);
  const [mdatName, setMdatName] = useState('');
  const [smplName, setSmplName] = useState('');
  const [error, setError] = useState('');
  const [decodedPatterns, setDecodedPatterns] = useState<PatternEntry[][]>([]);
  const [displayState, setDisplayState] = useState<PlaybackDisplayState>({
    currPos: 0,
    tracks: Array.from({ length: 8 }, () => ({ patternNum: -1, currentStep: 0, active: false, channelVolumes: Array(7).fill(0) })),
  });
  const [trackMuted, setTrackMuted] = useState<boolean[]>(Array(8).fill(false));
  const [positionLoopEnabled, setPositionLoopEnabled] = useState(false);

  const getAudio = useCallback((): TFMXAudio => {
    if (!audioRef.current) {
      audioRef.current = new TFMXAudio();
    }
    return audioRef.current;
  }, []);

  const handleMdatSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setMdatFile(file);
      setMdatName(file.name);
      setError('');
    }
  }, []);

  const handleSmplSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSmplFile(file);
      setSmplName(file.name);
      setError('');
    }
  }, []);

  const handleLoad = useCallback(async () => {
    if (!mdatFile || !smplFile) {
      setError('Please select both MDAT and SMPL files.');
      return;
    }

    try {
      setError('');
      const mdatBuf = await mdatFile.arrayBuffer();
      const smplBuf = await smplFile.arrayBuffer();

      const parsed = parseTFMX(mdatBuf, smplBuf);
      setData(parsed);
      setSongText(parsed.hdr.text);
      const numSongs = countSubSongs(parsed.hdr);
      setTotalSongs(numSongs);
      setSongNum(0);

      // Decode all patterns for the tracker display
      const decoded = decodeAllPatterns(parsed);
      setDecodedPatterns(decoded);

      const audio = getAudio();
      audio.load(parsed);
    } catch (err) {
      setError(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [mdatFile, smplFile, getAudio]);

  const handlePlay = useCallback(() => {
    if (!data) return;
    const audio = getAudio();
    if (audio.canResume) {
      // Was playing and got paused — resume from current position
      audio.resume();
    } else {
      // First play, or starting fresh after a song change
      audio.play(songNum);
    }
    setIsPlaying(true);
  }, [data, songNum, getAudio]);

  const handlePause = useCallback(() => {
    const audio = getAudio();
    audio.pause();
    setIsPlaying(false);
  }, [getAudio]);

  const handlePrev = useCallback(() => {
    if (!data) return;
    const newSong = songNum > 0 ? songNum - 1 : totalSongs - 1;
    setSongNum(newSong);
    if (isPlaying) {
      const audio = getAudio();
      audio.play(newSong);
    }
  }, [data, songNum, totalSongs, isPlaying, getAudio]);

  const handleNext = useCallback(() => {
    if (!data) return;
    const newSong = songNum < totalSongs - 1 ? songNum + 1 : 0;
    setSongNum(newSong);
    if (isPlaying) {
      const audio = getAudio();
      audio.play(newSong);
    }
  }, [data, songNum, totalSongs, isPlaying, getAudio]);

  const handleToggleMute = useCallback((track: number) => {
    const audio = getAudio();
    const newMuted = !audio.isTrackMuted(track);
    audio.setTrackMuted(track, newMuted);
    setTrackMuted(audio.getTrackMuteState());
  }, [getAudio]);

  const handleStepForward = useCallback(() => {
    const audio = getAudio();
    audio.stepPositionForward();

    // If paused, immediately update display state
    if (!isPlaying && audioRef.current) {
      const state = audioRef.current.playerInstance.getDisplayState();
      setDisplayState(state);
    }
  }, [getAudio, isPlaying]);

  const handleStepBackward = useCallback(() => {
    const audio = getAudio();
    audio.stepPositionBackward();

    // If paused, immediately update display state
    if (!isPlaying && audioRef.current) {
      const state = audioRef.current.playerInstance.getDisplayState();
      setDisplayState(state);
    }
  }, [getAudio, isPlaying]);

  const handleTogglePositionLoop = useCallback(() => {
    const audio = getAudio();
    const newState = audio.togglePositionLoop();
    setPositionLoopEnabled(newState);
  }, [getAudio]);

  // Poll player state at ~60fps for the pattern display
  useEffect(() => {
    if (!isPlaying) return;

    let animFrame: number;
    const update = () => {
      if (audioRef.current) {
        const state = audioRef.current.playerInstance.getDisplayState();
        setDisplayState(state);
      }
      animFrame = requestAnimationFrame(update);
    };

    animFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animFrame);
  }, [isPlaying]);

  return (
    <>
      <div className="top-section">
        <div className="player-container">
          <div className="player-header">
            <h1 className="player-title">TFMX Player</h1>
            <p className="player-subtitle">Amiga Music Format Player</p>
          </div>

          {/* File Loading */}
          <div className="file-section">
            <div className="file-row">
              <label className="file-label">
                <span className="file-label-text">MDAT</span>
                <input
                  type="file"
                  className="file-input"
                  onChange={handleMdatSelect}
                  accept="*"
                />
                <span className="file-button">Choose File</span>
                <span className="file-name">{mdatName || 'No file selected'}</span>
              </label>
            </div>
            <div className="file-row">
              <label className="file-label">
                <span className="file-label-text">SMPL</span>
                <input
                  type="file"
                  className="file-input"
                  onChange={handleSmplSelect}
                  accept="*"
                />
                <span className="file-button">Choose File</span>
                <span className="file-name">{smplName || 'No file selected'}</span>
              </label>
            </div>
            <p className="file-hint">
              Select matching MDAT and SMPL files (e.g. <code>mdat.world_1</code> and <code>smpl.world_1</code>)
            </p>
            <button
              className="load-button"
              onClick={handleLoad}
              disabled={!mdatFile || !smplFile}
            >
              Load Module
            </button>
            {error && <p className="error-text">{error}</p>}
          </div>

          {/* Song Info */}
          {data && (
            <div className="info-section">
              <div className="info-text">
                {songText.map((line, i) => (
                  <div key={i} className="info-line">{line}</div>
                ))}
              </div>
              <div className="song-indicator">
                Sub-song {songNum + 1} / {totalSongs}
              </div>
            </div>
          )}

          {/* Transport Controls */}
          <div className="transport-section">
            <button
              className="transport-btn"
              onClick={handlePrev}
              disabled={!data}
              title="Previous sub-song"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>
            <button
              className={`transport-btn play-btn ${isPlaying ? 'active' : ''}`}
              onClick={isPlaying ? handlePause : handlePlay}
              disabled={!data}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button
              className="transport-btn"
              onClick={handleNext}
              disabled={!data}
              title="Next sub-song"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>

          {/* Position Controls */}
          {data && (
            <div className="position-section">
              <div className="position-label">Position</div>
              <div className="position-controls">
                <button
                  className="position-btn"
                  onClick={handleStepBackward}
                  disabled={!data}
                  title="Previous position"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                  </svg>
                </button>

                <div className="position-display">
                  <span className="position-current">
                    {String(displayState.currPos).padStart(2, '0')}
                  </span>
                  <span className="position-separator">/</span>
                  <span className="position-total">
                    {String(audioRef.current?.getPositionRange().last ?? 0).padStart(2, '0')}
                  </span>
                </div>

                <button
                  className="position-btn"
                  onClick={handleStepForward}
                  disabled={!data}
                  title="Next position"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                  </svg>
                </button>

                <button
                  className={`position-loop-btn ${positionLoopEnabled ? 'active' : ''}`}
                  onClick={handleTogglePositionLoop}
                  disabled={!data}
                  title={positionLoopEnabled ? "Disable position loop" : "Loop current position"}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Explorer Panel — beside the player controls */}
        {data && (
          <ExplorerPanel data={data} audio={getAudio()} />
        )}
      </div>

      {/* Pattern View — full width, below the top section */}
      {data && decodedPatterns.length > 0 && (
        <div className="pattern-view-wrapper">
          <PatternView
            decodedPatterns={decodedPatterns}
            displayState={displayState}
            trackMuted={trackMuted}
            onToggleMute={handleToggleMute}
          />
        </div>
      )}
    </>
  );
}

