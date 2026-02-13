import { useState, useRef, useCallback } from 'react';
import { TFMXAudio, parseTFMX, countSubSongs } from '../tfmx';
import type { TFMXData } from '../tfmx';
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

      const audio = getAudio();
      audio.load(parsed);
    } catch (err) {
      setError(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [mdatFile, smplFile, getAudio]);

  const handlePlay = useCallback(() => {
    if (!data) return;
    const audio = getAudio();
    if (audio.isPaused && isPlaying) {
      audio.resume();
    } else {
      audio.play(songNum);
    }
    setIsPlaying(true);
  }, [data, songNum, isPlaying, getAudio]);

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

  return (
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
    </div>
  );
}

