import React, { useState, useRef, useEffect } from 'react';
import { Upload, BookOpen, ListVideo, X, Trash2, AlertCircle, Loader2, WifiOff, Wifi, ToggleLeft, ToggleRight, Download, CheckCircle2, ChevronDown, Settings, RefreshCw, Check } from 'lucide-react';
import { SubtitleSegment, WordDefinition, VocabularyItem, PlaybackMode, LocalLLMConfig } from './types';
import { generateSubtitles, getWordDefinition, preloadOfflineModel, setLoadProgressCallback, fetchLocalModels } from './services/geminiService';
import { VideoControls } from './components/VideoControls';
import { WordDefinitionPanel } from './components/WordDefinitionPanel';

const OFFLINE_MODELS = [
    { id: 'Xenova/whisper-tiny', name: 'Tiny (Fastest, ~40MB)' },
    { id: 'Xenova/whisper-base', name: 'Base (Balanced, ~75MB)' },
    { id: 'Xenova/whisper-small', name: 'Small (High Quality, ~250MB)' },
];

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export default function App() {
  // Media State
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null); // Store the actual file
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
  const [isOffline, setIsOffline] = useState(true); // Default to offline
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadingWord, setLoadingWord] = useState(false);
  const [selectedWord, setSelectedWord] = useState<WordDefinition | null>(null);
  const [showVocabSidebar, setShowVocabSidebar] = useState(true);

  // Local LLM State
  const [localLLMConfig, setLocalLLMConfig] = useState<LocalLLMConfig>(() => {
      try {
        const saved = localStorage.getItem('lingo_local_llm');
        return saved ? JSON.parse(saved) : { enabled: false, endpoint: 'http://localhost:11434', model: '' };
      } catch {
        return { enabled: false, endpoint: 'http://localhost:11434', model: '' };
      }
  });
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [checkingModel, setCheckingModel] = useState(false);

  // Model Management State
  const [selectedModelId, setSelectedModelId] = useState(OFFLINE_MODELS[0].id);
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [downloadProgress, setDownloadProgress] = useState<{ file: string; progress: number } | null>(null);

  // Race condition protection
  const processingIdRef = useRef(0);

  // --- Local Settings Persistence ---
  useEffect(() => {
    localStorage.setItem('lingo_local_llm', JSON.stringify(localLLMConfig));
  }, [localLLMConfig]);

  // --- Model Preload Logic ---
  useEffect(() => {
    // Register the callback to listen for model download events
    setLoadProgressCallback((data) => {
        if (data.status === 'progress') {
            setModelStatus('loading');
            setDownloadProgress({ file: data.file, progress: data.progress || 0 });
        } else if (data.status === 'ready') {
            setModelStatus('ready');
            setDownloadProgress(null);
        } else if (data.status === 'done') {
            // Individual file done
        }
    });
  }, []);

  const handlePreloadModel = () => {
    setModelStatus('loading');
    preloadOfflineModel(selectedModelId);
  };

  const handleModelChange = (newModelId: string) => {
      if (newModelId !== selectedModelId) {
          setSelectedModelId(newModelId);
          // We reset status because we don't know if this new model is cached/ready
          setModelStatus('idle');
          setDownloadProgress(null);
      }
  };

  const checkLocalConnection = async () => {
    setCheckingModel(true);
    try {
        const models = await fetchLocalModels(localLLMConfig.endpoint);
        setLocalModels(models);
        // Auto-select first if none selected
        if (!localLLMConfig.model && models.length > 0) {
            setLocalLLMConfig(p => ({ ...p, model: models[0] }));
        }
    } catch (e) {
        alert("Could not connect to Local LLM. Make sure Ollama is running and accessible (check CORS settings).");
    } finally {
        setCheckingModel(false);
    }
  };


  // --- File Handling ---
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset player specific state immediately
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    
    // Set video source for the player
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    
    // Update file state - this will trigger the useEffect to start processing
    setVideoFile(file);
  };

  // Effect to handle Subtitle Generation (Runs on new file OR mode switch OR model switch)
  useEffect(() => {
    if (!videoFile) return;

    const currentId = processingIdRef.current + 1;
    processingIdRef.current = currentId;

    const processVideoForSubtitles = async () => {
        // Reset UI for processing state
        setSubtitles([]);
        setCurrentSegmentIndex(-1);
        setSelectedWord(null);
        setIsProcessing(true);
        setErrorMsg(null);

        // If offline and model not ready, this will likely trigger download events too
        if (isOffline && modelStatus === 'idle') {
            setModelStatus('loading');
        }

        try {
          await generateSubtitles(videoFile, (newSegments) => {
               // Only update if this request is still the active one
               if (processingIdRef.current === currentId) {
                   setSubtitles(newSegments);
               }
          }, isOffline, selectedModelId);
          
          if (!isOffline && processingIdRef.current === currentId) {
             setIsProcessing(false);
          }
        } catch (error) {
          console.error("Subtitle generation failed", error);
          if (processingIdRef.current === currentId) {
              setErrorMsg(`Could not generate subtitles (${isOffline ? 'Offline' : 'Online'}).`);
              setIsProcessing(false);
          }
        }
    };

    // Small timeout to ensure UI updates state before heavy processing starts
    const timer = setTimeout(() => {
        processVideoForSubtitles();
    }, 100);

    return () => clearTimeout(timer);

  }, [videoFile, isOffline, selectedModelId]);


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

    // FIX: Partial/Looping Logic
    // If in loop mode, ensure we stay within the segment bounds strictly
    if (playbackMode === PlaybackMode.LOOP_SENTENCE && currentSegmentIndex !== -1) {
      const segment = subtitles[currentSegmentIndex];
      if (segment && time >= segment.end) {
        videoRef.current.currentTime = segment.start;
        // Do not proceed to find next index to prevent skipping
        return;
      }
    }

    // Find current subtitle (Standard logic)
    const index = subtitles.findIndex(sub => time >= sub.start && time < sub.end);
    if (index !== -1 && index !== currentSegmentIndex) {
      setCurrentSegmentIndex(index);
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
    const cleanWord = word.replace(/[.,!?;:"()]/g, "").trim();
    if (!cleanWord) return;

    const context = subtitles[currentSegmentIndex]?.text || "No context available";

    setLoadingWord(true);
    try {
      // Pass local config to service
      const def = await getWordDefinition(cleanWord, context, isOffline, localLLMConfig);
      setSelectedWord(def);
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
      
      {/* SETTINGS MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md p-6 relative animate-in zoom-in-95 duration-200">
                <button 
                    onClick={() => setIsSettingsOpen(false)} 
                    className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
                >
                    <X size={24} />
                </button>

                <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                    <Settings className="text-blue-500" />
                    Local AI Settings
                </h3>
                
                {/* Enable Toggle */}
                <div className="flex items-center justify-between mb-6 p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                    <div className="flex flex-col">
                        <span className="font-medium text-gray-200">Enable Local LLM</span>
                        <span className="text-xs text-gray-500">Use local Ollama for definitions</span>
                    </div>
                    <button 
                        onClick={() => setLocalLLMConfig(p => ({...p, enabled: !p.enabled}))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${localLLMConfig.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
                    >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${localLLMConfig.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                </div>

                {/* Configuration Fields */}
                <div className={`space-y-5 transition-opacity duration-200 ${localLLMConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Endpoint URL</label>
                        <div className="flex gap-2">
                            <input 
                                type="text" 
                                value={localLLMConfig.endpoint}
                                onChange={(e) => setLocalLLMConfig(p => ({...p, endpoint: e.target.value}))}
                                className="flex-1 bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none transition-all placeholder-gray-700"
                                placeholder="http://localhost:11434"
                            />
                            <button 
                                onClick={checkLocalConnection}
                                disabled={checkingModel}
                                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 text-gray-300 transition-colors disabled:opacity-50"
                                title="Check Connection & Fetch Models"
                            >
                                {checkingModel ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                            </button>
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Model Name</label>
                        {localModels.length > 0 ? (
                            <div className="relative">
                                <select 
                                    value={localLLMConfig.model}
                                    onChange={(e) => setLocalLLMConfig(p => ({...p, model: e.target.value}))}
                                    className="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none appearance-none cursor-pointer"
                                >
                                    <option value="">Select a model...</option>
                                    {localModels.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                                <ChevronDown size={14} className="absolute right-3 top-3 text-gray-500 pointer-events-none" />
                            </div>
                        ) : (
                             <input 
                                type="text" 
                                value={localLLMConfig.model}
                                onChange={(e) => setLocalLLMConfig(p => ({...p, model: e.target.value}))}
                                className="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none placeholder-gray-700"
                                placeholder="e.g. llama3, mistral"
                            />
                        )}
                        <p className="text-[10px] text-gray-500 mt-2">
                            Click the refresh icon to list installed models from your local endpoint.
                        </p>
                    </div>
                </div>

                <div className="mt-8 flex justify-end">
                    <button 
                        onClick={() => setIsSettingsOpen(false)}
                        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors shadow-lg shadow-blue-900/20"
                    >
                        Save & Close
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* LEFT SIDEBAR: TRANSCRIPT */}
      <div className="w-80 bg-gray-950 border-r border-gray-800 flex flex-col flex-shrink-0 hidden md:flex">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <ListVideo className="text-blue-500" />
                    <h2 className="font-bold text-lg">Transcript</h2>
                </div>
                
                {/* MODE TOGGLE */}
                <button 
                onClick={() => setIsOffline(!isOffline)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    isOffline 
                    ? 'bg-green-900/20 border-green-800 text-green-400 hover:bg-green-900/30' 
                    : 'bg-blue-900/20 border-blue-800 text-blue-400 hover:bg-blue-900/30'
                }`}
                title={isOffline ? "Switch to Online Mode (Gemini API)" : "Switch to Offline Mode (Local AI)"}
                >
                {isOffline ? <WifiOff size={14} /> : <Wifi size={14} />}
                <span>{isOffline ? 'Offline' : 'Online'}</span>
                </button>
            </div>

            {/* MODEL MANAGER (OFFLINE MODE ONLY) */}
            {isOffline && (
                <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
                    <div className="flex items-center justify-between mb-2">
                         <span className="text-xs text-gray-400 font-semibold uppercase tracking-wider">AI Model (Whisper)</span>
                         {modelStatus === 'ready' && <CheckCircle2 size={14} className="text-green-500" />}
                    </div>
                    
                    {/* MODEL SELECTOR */}
                    <div className="mb-3 relative">
                        <select 
                            value={selectedModelId}
                            onChange={(e) => handleModelChange(e.target.value)}
                            className="w-full bg-gray-900 text-white text-xs border border-gray-600 rounded px-2 py-1.5 appearance-none focus:outline-none focus:border-blue-500"
                            disabled={modelStatus === 'loading'}
                        >
                            {OFFLINE_MODELS.map(model => (
                                <option key={model.id} value={model.id}>{model.name}</option>
                            ))}
                        </select>
                        <ChevronDown size={12} className="absolute right-2 top-2.5 text-gray-400 pointer-events-none" />
                    </div>
                    
                    {modelStatus === 'idle' && (
                        <button 
                            onClick={handlePreloadModel}
                            className="w-full flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 text-white text-xs py-2 rounded transition-colors"
                        >
                            <Download size={14} />
                            <span>Load Model</span>
                        </button>
                    )}

                    {modelStatus === 'loading' && (
                        <div className="space-y-2">
                             <div className="flex items-center gap-2 text-xs text-blue-300">
                                 <Loader2 size={12} className="animate-spin" />
                                 <span>{downloadProgress ? `Downloading... ${Math.round(downloadProgress.progress)}%` : 'Initializing...'}</span>
                             </div>
                             {downloadProgress && (
                                <div className="h-1 w-full bg-gray-700 rounded-full overflow-hidden">
                                    <div 
                                        className="h-full bg-blue-500 transition-all duration-300" 
                                        style={{ width: `${downloadProgress.progress}%` }} 
                                    />
                                </div>
                             )}
                             <div className="text-[10px] text-gray-500 truncate">
                                {downloadProgress?.file || "Preparing environment..."}
                             </div>
                        </div>
                    )}

                    {modelStatus === 'ready' && (
                        <div className="text-xs text-gray-400">
                            Model cached & ready.
                        </div>
                    )}
                </div>
            )}
        </div>
        
        <div className="flex-1 overflow-y-auto p-0 scroll-smooth relative">
          {subtitles.length === 0 && isProcessing ? (
             <div className="p-8 flex flex-col items-center gap-3 text-gray-500 text-sm">
                <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-center">
                  {isOffline ? `Running ${OFFLINE_MODELS.find(m => m.id === selectedModelId)?.name.split(' ')[0]} Model...` : "Processing with Gemini Cloud..."}
                </span>
            </div>
          ) : subtitles.length === 0 && !isProcessing ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              {errorMsg ? (
                <span className="text-red-400">{errorMsg}</span>
              ) : (
                <span className="opacity-60">Load a video to generate subtitles.</span>
              )}
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
                
                {/* Streaming Indicator in List */}
                {isProcessing && subtitles.length > 0 && (
                   <div className="p-4 flex items-center justify-center gap-2 text-xs text-gray-500 animate-pulse">
                      <Loader2 size={12} className="animate-spin" />
                      <span>Transcribing more segments...</span>
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

        {/* MAIN CONTENT AREA */}
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
                <p>Please load a local video file.</p>
                <p className="text-xs text-gray-500 mt-2">
                   {isOffline ? "Ready for Offline Mode" : "Ready for Online Mode"}
                </p>
              </div>
            )}
          </div>

          {/* 2. DEDICATED SUBTITLE AREA */}
          <div className="bg-gray-900 border-b border-t border-gray-800 p-6 text-center min-h-[120px] flex items-center justify-center">
             {/* Show spinner ONLY if we have NO subtitles yet. If we have partials, show them! */}
             {isProcessing && subtitles.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 animate-pulse">
                     <span className="text-blue-400 text-sm font-medium">
                       {isOffline ? `Analyzing Audio (${OFFLINE_MODELS.find(m => m.id === selectedModelId)?.name.split(' ')[0]})...` : "Analyzing Audio (Gemini 2.0)..."}
                     </span>
                     <span className="text-gray-600 text-xs">
                        {isOffline ? "Running locally on your device." : "Uploading and processing in the cloud."}
                     </span>
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
              <div className="flex items-center gap-1">
                 {/* SETTINGS BUTTON */}
                 <button 
                    onClick={() => setIsSettingsOpen(true)}
                    className="p-1.5 text-gray-500 hover:text-white rounded-md transition-colors"
                    title="Settings (Local LLM)"
                 >
                    <Settings size={18} />
                 </button>
                 <button onClick={() => setShowVocabSidebar(false)} className="md:hidden text-gray-500">
                    <X size={20} />
                 </button>
              </div>
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