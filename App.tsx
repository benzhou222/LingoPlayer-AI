import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, BookOpen, ListVideo, X, Trash2, AlertCircle, Loader2 } from 'lucide-react';
import { SubtitleSegment, WordDefinition, VocabularyItem, PlaybackMode } from './types';
import { generateSubtitles, getWordDefinition } from './services/geminiService';
import { VideoControls } from './components/VideoControls';
import { WordDefinitionPanel } from './components/WordDefinitionPanel';

export default function App() {
  // Media State
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // App Data State
  const [subtitles, setSubtitles] = useState<SubtitleSegment[]>([]);
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  
  // Playback State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(PlaybackMode.CONTINUOUS);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState<number>(-1);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);

  // UI State
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadingWord, setLoadingWord] = useState(false);
  const [selectedWord, setSelectedWord] = useState<WordDefinition | null>(null);
  const [showVocabSidebar, setShowVocabSidebar] = useState(true);

  // --- File Handling ---
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset state but don't block
    setSubtitles([]);
    setCurrentSegmentIndex(-1);
    setSelectedWord(null);
    setIsProcessing(true);
    setErrorMsg(null);
    setCurrentTime(0);
    setDuration(0);

    // Create object URL for video immediately so user can watch
    const url = URL.createObjectURL(file);
    setVideoSrc(url);

    // Defer the heavy AI processing to ensure UI updates first and video can play
    requestAnimationFrame(() => {
        setTimeout(() => {
            processVideoForSubtitles(file);
        }, 100);
    });
  };

  const processVideoForSubtitles = async (file: File) => {
      try {
        await generateSubtitles(file, (newSegments) => {
             setSubtitles(prev => [...prev, ...newSegments]);
        });
      } catch (error) {
        console.error("Subtitle generation failed", error);
        setErrorMsg("Could not generate subtitles. You can still watch the video.");
      } finally {
        setIsProcessing(false);
      }
  };

  // --- Video Logic ---
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const time = videoRef.current.currentTime;
    setCurrentTime(time);

    // Find current subtitle
    const index = subtitles.findIndex(sub => time >= sub.start && time < sub.end);
    if (index !== -1 && index !== currentSegmentIndex) {
      setCurrentSegmentIndex(index);
    }

    // Loop Logic
    if (playbackMode === PlaybackMode.LOOP_SENTENCE && currentSegmentIndex !== -1) {
      const segment = subtitles[currentSegmentIndex];
      if (segment && time >= segment.end) {
        videoRef.current.currentTime = segment.start;
        videoRef.current.play();
      }
    }
  };

  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const jumpToSegment = (index: number) => {
    if (!videoRef.current || !subtitles[index]) return;
    const segment = subtitles[index];
    videoRef.current.currentTime = segment.start;
    setCurrentSegmentIndex(index);
    if (!isPlaying) {
        videoRef.current.play();
        setIsPlaying(true);
    }
  };

  const handlePrevSentence = () => {
    if (currentSegmentIndex > 0) jumpToSegment(currentSegmentIndex - 1);
  };

  const handleNextSentence = () => {
    if (currentSegmentIndex < subtitles.length - 1) jumpToSegment(currentSegmentIndex + 1);
  };

  const togglePlayPause = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  // Volume Logic
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) setIsMuted(false);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  // --- Dictionary Logic ---
  const handleWordClick = async (word: string) => {
    // Basic cleanup of punctuation
    const cleanWord = word.replace(/[.,!?;:"()]/g, "").trim();
    if (!cleanWord) return;

    // Get context
    const context = subtitles[currentSegmentIndex]?.text || "No context available";

    setLoadingWord(true);
    try {
      const def = await getWordDefinition(cleanWord, context);
      setSelectedWord(def);
      // Pause video when user wants to learn
      if (videoRef.current && isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingWord(false);
    }
  };

  // --- Vocabulary Logic ---
  const addToVocab = (wordDef: WordDefinition) => {
    if (vocabulary.some(v => v.word === wordDef.word)) return;
    const newItem: VocabularyItem = {
      ...wordDef,
      id: crypto.randomUUID(),
      addedAt: Date.now()
    };
    setVocabulary(prev => [newItem, ...prev]);
  };

  const removeFromVocab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setVocabulary(prev => prev.filter(item => item.id !== id));
  };

  const handleVocabItemClick = (item: VocabularyItem) => {
    setSelectedWord(item);
    if (videoRef.current && isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // --- Render Helpers ---
  const renderInteractiveSubtitle = (text: string) => {
    return text.split(" ").map((word, i) => (
      <span 
        key={i} 
        onClick={(e) => { e.stopPropagation(); handleWordClick(word); }}
        className="cursor-pointer hover:text-blue-400 hover:bg-white/10 rounded px-1 transition-colors select-none inline-block"
      >
        {word}{" "}
      </span>
    ));
  };

  return (
    <div className="flex h-screen bg-black text-gray-100 font-sans overflow-hidden">
      
      {/* LEFT SIDEBAR: TRANSCRIPT */}
      <div className="w-80 bg-gray-950 border-r border-gray-800 flex flex-col flex-shrink-0 hidden md:flex">
        <div className="p-4 border-b border-gray-800 flex items-center gap-2">
            <ListVideo className="text-blue-500" />
            <h2 className="font-bold text-lg">Transcript</h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-0 scroll-smooth">
          {subtitles.length === 0 && isProcessing ? (
             <div className="p-8 flex flex-col items-center gap-3 text-gray-500 text-sm">
                <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <span>Starting analysis...</span>
            </div>
          ) : subtitles.length === 0 && !isProcessing ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              {errorMsg ? (
                <span className="text-red-400">{errorMsg}</span>
              ) : "Load a video to see subtitles."}
            </div>
          ) : (
             <>
                {subtitles.map((sub, idx) => (
                <div
                    key={sub.id}
                    onClick={() => jumpToSegment(idx)}
                    className={`p-4 border-b border-gray-800 cursor-pointer transition-all hover:bg-gray-800 ${
                    currentSegmentIndex === idx ? 'bg-blue-900/20 border-l-4 border-l-blue-500' : 'border-l-4 border-l-transparent'
                    }`}
                >
                    <div className="flex justify-between mb-1">
                    <span className="text-xs text-gray-500 font-mono">{formatTime(sub.start)}</span>
                    </div>
                    <p className={`text-sm leading-relaxed ${currentSegmentIndex === idx ? 'text-white' : 'text-gray-400'}`}>
                    {sub.text}
                    </p>
                </div>
                ))}
                
                {isProcessing && (
                     <div className="p-4 flex items-center justify-center gap-2 text-gray-500 text-xs border-t border-gray-800/50 bg-gray-900/50">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Generating more segments...</span>
                    </div>
                )}
             </>
          )}
        </div>
      </div>

      {/* CENTER: VIDEO PLAYER AREA */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900 relative">
        
        {/* TOP BAR */}
        <div className="h-16 flex items-center justify-between px-6 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">LingoPlayer AI</h1>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm font-medium rounded-lg cursor-pointer transition-colors border border-gray-700">
                <Upload size={16} />
                <span>Load Video</span>
                <input type="file" accept="video/*" onChange={handleFileChange} className="hidden" />
            </label>
            <button 
                onClick={() => setShowVocabSidebar(!showVocabSidebar)}
                className={`p-2 rounded-lg transition-colors ${showVocabSidebar ? 'text-blue-400 bg-blue-900/20' : 'text-gray-400 hover:text-white'}`}
            >
                <BookOpen size={20} />
            </button>
          </div>
        </div>

        {/* MAIN CONTENT AREA: SCROLLABLE IF HEIGHT IS SMALL, BUT IDEALLY FIXED */}
        <div className="flex-1 flex flex-col overflow-hidden">
          
          {/* 1. VIDEO CONTAINER */}
          <div className="flex-grow bg-black flex items-center justify-center relative min-h-[300px]">
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                className="w-full h-full object-contain"
                onClick={togglePlayPause}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={() => setIsPlaying(false)}
                playsInline
              />
            ) : (
              <div className="text-gray-600 flex flex-col items-center">
                <Upload size={48} className="mb-4 opacity-50" />
                <p>Please load a local video file to begin.</p>
              </div>
            )}
          </div>

          {/* 2. DEDICATED SUBTITLE AREA */}
          <div className="bg-gray-900 border-b border-t border-gray-800 p-6 text-center min-h-[120px] flex items-center justify-center">
             {isProcessing && subtitles.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 animate-pulse">
                     <span className="text-blue-400 text-sm font-medium">Generating AI Subtitles...</span>
                     <span className="text-gray-600 text-xs">Video is ready. Segments will appear as they are processed.</span>
                </div>
             ) : errorMsg ? (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 px-4 py-2 rounded">
                    <AlertCircle size={16} />
                    <span>{errorMsg}</span>
                </div>
             ) : currentSegmentIndex !== -1 ? (
              <div className="text-xl md:text-2xl text-white font-medium leading-relaxed max-w-4xl">
                 {renderInteractiveSubtitle(subtitles[currentSegmentIndex].text)}
              </div>
            ) : (
              <div className="text-gray-600 italic">
                {subtitles.length > 0 ? "Play video to see subtitles..." : videoSrc && !isProcessing ? "No subtitles found." : "Subtitles will appear here..."}
              </div>
            )}
          </div>

          {/* 3. WORD DEFINITION PANEL */}
          <WordDefinitionPanel 
              definition={selectedWord} 
              onAddToVocab={addToVocab}
              isSaved={selectedWord ? vocabulary.some(v => v.word === selectedWord.word) : false}
              isLoading={loadingWord}
          />
          
          {/* 4. CONTROLS */}
          <VideoControls 
              isPlaying={isPlaying}
              onPlayPause={togglePlayPause}
              playbackMode={playbackMode}
              onToggleMode={() => setPlaybackMode(m => m === PlaybackMode.CONTINUOUS ? PlaybackMode.LOOP_SENTENCE : PlaybackMode.CONTINUOUS)}
              playbackRate={playbackRate}
              onRateChange={handleRateChange}
              onPrevSentence={handlePrevSentence}
              onNextSentence={handleNextSentence}
              hasSubtitles={subtitles.length > 0}
              currentTime={currentTime}
              duration={duration}
              onSeek={handleSeek}
              volume={volume}
              onVolumeChange={handleVolumeChange}
              isMuted={isMuted}
              onToggleMute={toggleMute}
          />

        </div>
      </div>

      {/* RIGHT SIDEBAR: VOCABULARY */}
      {showVocabSidebar && (
        <div className="w-80 bg-gray-950 border-l border-gray-800 flex flex-col flex-shrink-0 animate-in slide-in-from-right duration-300 absolute md:static inset-y-0 right-0 z-50 md:z-auto shadow-2xl md:shadow-none">
           <div className="p-4 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookOpen className="text-green-500" />
                <h2 className="font-bold text-lg">Vocabulary</h2>
              </div>
              <button onClick={() => setShowVocabSidebar(false)} className="md:hidden text-gray-500">
                  <X size={20} />
              </button>
           </div>

           <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {vocabulary.length === 0 ? (
                  <div className="text-center text-gray-600 mt-10 text-sm">
                      <p>Your notebook is empty.</p>
                      <p className="mt-2">Click words in the subtitles to add them here.</p>
                  </div>
              ) : (
                  vocabulary.map(item => (
                      <div 
                        key={item.id} 
                        onClick={() => handleVocabItemClick(item)}
                        className="bg-gray-900 rounded-lg p-3 border border-gray-800 hover:border-gray-700 transition-colors group relative cursor-pointer"
                      >
                          <div className="flex justify-between items-start mb-1">
                              <h3 className="font-bold text-blue-300">{item.word}</h3>
                              <span className="text-xs text-gray-500 italic">{item.partOfSpeech}</span>
                          </div>
                          <div className="text-xs text-gray-400 mb-2 font-mono">/{item.phonetic}/</div>
                          <p className="text-sm text-gray-300 line-clamp-2" title={item.meaning}>{item.meaning}</p>
                          
                          <button 
                            onClick={(e) => removeFromVocab(e, item.id)}
                            className="absolute top-2 right-2 p-1.5 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Remove word"
                          >
                             <Trash2 size={14} />
                          </button>
                      </div>
                  ))
              )}
           </div>
        </div>
      )}

    </div>
  );
}

// Utility
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}