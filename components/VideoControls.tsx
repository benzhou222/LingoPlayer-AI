import React from 'react';
import { 
  Play, Pause, Repeat, Repeat1, 
  SkipBack, SkipForward, FastForward,
  Volume2, VolumeX
} from 'lucide-react';
import { PlaybackMode } from '../types';

interface VideoControlsProps {
  isPlaying: boolean;
  onPlayPause: () => void;
  playbackMode: PlaybackMode;
  onToggleMode: () => void;
  playbackRate: number;
  onRateChange: (rate: number) => void;
  onPrevSentence: () => void;
  onNextSentence: () => void;
  hasSubtitles: boolean;
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  volume: number;
  onVolumeChange: (val: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
}

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const VideoControls: React.FC<VideoControlsProps> = ({
  isPlaying,
  onPlayPause,
  playbackMode,
  onToggleMode,
  playbackRate,
  onRateChange,
  onPrevSentence,
  onNextSentence,
  hasSubtitles,
  currentTime,
  duration,
  onSeek,
  volume,
  onVolumeChange,
  isMuted,
  onToggleMute
}) => {
  const rates = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

  return (
    <div className="bg-gray-900 border-t border-gray-800 p-4 flex flex-col gap-3 select-none">
      
      {/* Progress Bar */}
      <div className="flex items-center gap-3 text-xs text-gray-400 font-mono">
        <span className="min-w-[40px] text-right">{formatTime(currentTime)}</span>
        <input 
          type="range"
          min={0}
          max={duration || 100}
          step={0.1}
          value={currentTime}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400 transition-all"
        />
        <span className="min-w-[40px]">{formatTime(duration)}</span>
      </div>

      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Playback Transport */}
        <div className="flex items-center space-x-4">
          <button
            onClick={onPrevSentence}
            disabled={!hasSubtitles}
            className="p-2 text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
            title="Previous Sentence"
          >
            <SkipBack size={24} />
          </button>

          <button
            onClick={onPlayPause}
            className="p-3 bg-blue-600 rounded-full text-white hover:bg-blue-500 transition-colors shadow-lg shadow-blue-900/20"
          >
            {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
          </button>

          <button
            onClick={onNextSentence}
            disabled={!hasSubtitles}
            className="p-2 text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
            title="Next Sentence"
          >
            <SkipForward size={24} />
          </button>

          {/* Volume Control */}
          <div className="flex items-center gap-2 group ml-2">
            <button onClick={onToggleMute} className="text-gray-400 hover:text-white">
              {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            <div className="w-0 overflow-hidden group-hover:w-20 transition-all duration-300 ease-in-out flex items-center">
               <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="w-20 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-gray-200"
              />
            </div>
          </div>
        </div>

        {/* Mode & Speed */}
        <div className="flex items-center space-x-6">
          
          {/* Loop Mode Toggle */}
          <button
            onClick={onToggleMode}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg border transition-all ${
              playbackMode === PlaybackMode.LOOP_SENTENCE 
                ? 'bg-blue-900/50 border-blue-500 text-blue-200' 
                : 'bg-transparent border-gray-700 text-gray-400 hover:text-white'
            }`}
            title={playbackMode === PlaybackMode.LOOP_SENTENCE ? "Looping Current Sentence" : "Continuous Play"}
          >
            {playbackMode === PlaybackMode.LOOP_SENTENCE ? <Repeat1 size={18} /> : <Repeat size={18} />}
            <span className="text-sm font-medium">
              {playbackMode === PlaybackMode.LOOP_SENTENCE ? 'Sentence Loop' : 'Continuous'}
            </span>
          </button>

          {/* Speed Selector */}
          <div className="flex items-center space-x-2 bg-gray-800 rounded-lg p-1">
              <FastForward size={16} className="text-gray-400 ml-2" />
              <select 
                value={playbackRate} 
                onChange={(e) => onRateChange(parseFloat(e.target.value))}
                className="bg-transparent text-sm text-white focus:outline-none p-1 cursor-pointer"
              >
                {rates.map(r => (
                  <option key={r} value={r} className="bg-gray-800">{r}x</option>
                ))}
              </select>
          </div>
        </div>
      </div>
    </div>
  );
};