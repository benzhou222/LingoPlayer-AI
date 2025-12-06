import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, BookOpen, ListVideo, X, Trash2, AlertCircle, Loader2, WifiOff, Wifi, ToggleLeft, ToggleRight, Download, CheckCircle2, ChevronDown, Settings, RefreshCw, Check, AlertTriangle, GripVertical, GripHorizontal, Cloud, Server } from 'lucide-react';
import { SubtitleSegment, WordDefinition, VocabularyItem, PlaybackMode, LocalLLMConfig, GeminiConfig } from './types';
import { generateSubtitles, getWordDefinition, preloadOfflineModel, setLoadProgressCallback, fetchLocalModels } from './services/geminiService';
import { VideoControls } from './components/VideoControls';
import { WordDefinitionPanel } from './components/WordDefinitionPanel';
import { extractAudioAsWav } from './services/converterService';

const OFFLINE_MODELS = [
    { id: 'Xenova/whisper-tiny', name: 'Tiny (Multilingual, ~40MB)' },
    { id: 'Xenova/whisper-tiny.en', name: 'Tiny English (Fastest, ~40MB)' },
    { id: 'Xenova/whisper-base', name: 'Base (Multilingual, ~75MB)' },
    { id: 'Xenova/whisper-base.en', name: 'Base English (Balanced, ~75MB)' },
    { id: 'Xenova/whisper-small', name: 'Small (Multilingual, ~250MB)' },
    { id: 'Xenova/whisper-small.en', name: 'Small English (High Quality, ~250MB)' },
    { id: 'Xenova/whisper-medium', name: 'Medium (Very High Quality, ~1.5GB)' },
    { id: 'Xenova/whisper-medium.en', name: 'Medium English (Very High Quality, ~1.5GB)' },
    { id: 'Xenova/distil-whisper-large-v3', name: 'Distil-Large V3 (Best Accuracy, ~1.2GB)' },
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
  const [showModelAlert, setShowModelAlert] = useState(false); // Alert modal state

  // Layout Resizing State
  const [leftPanelWidth, setLeftPanelWidth] = useState(320);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);
  const [videoHeight, setVideoHeight] = useState(450); // Default video height
  const [subtitleHeight, setSubtitleHeight] = useState(200); // Default subtitle height
  
  const isResizingLeft = useRef(false);
  const isResizingRight = useRef(false);
  const isResizingVideo = useRef(false);
  const isResizingSubtitle = useRef(false);

  // AI Configuration State
  const [settingsTab, setSettingsTab] = useState<'online' | 'local'>('local');
  
  // Local LLM State
  const [localLLMConfig, setLocalLLMConfig] = useState<LocalLLMConfig>(() => {
      try {
        const saved = localStorage.getItem('lingo_local_llm');
        return saved ? JSON.parse(saved) : { enabled: false, endpoint: 'http://localhost:11434', model: '' };
      } catch {
        return { enabled: false, endpoint: 'http://localhost:11434', model: '' };
      }
  });
  
  // Online Gemini State
  const [geminiConfig, setGeminiConfig] = useState<GeminiConfig>(() => {
      try {
        const saved = localStorage.getItem('lingo_gemini_config');
        return saved ? JSON.parse(saved) : { apiKey: '' };
      } catch {
        return { apiKey: '' };
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

  // --- Settings Persistence ---
  useEffect(() => {
    localStorage.setItem('lingo_local_llm', JSON.stringify(localLLMConfig));
  }, [localLLMConfig]);

  useEffect(() => {
    localStorage.setItem('lingo_gemini_config', JSON.stringify(geminiConfig));
  }, [geminiConfig]);

  // --- Resizing Logic ---
  const startResizingLeft = useCallback(() => {
    isResizingLeft.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const startResizingRight = useCallback(() => {
    isResizingRight.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const startResizingVideo = useCallback(() => {
    isResizingVideo.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const startResizingSubtitle = useCallback(() => {
    isResizingSubtitle.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const stopResizing = useCallback(() => {
    isResizingLeft.current = false;
    isResizingRight.current = false;
    isResizingVideo.current = false;
    isResizingSubtitle.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    
    // Estimate fixed vertical space (Header ~64px + Controls ~180px + Resizers ~8px)
    // We leave a generous buffer to ensure flex items don't overflow
    const CHROME_HEIGHT = 250; 
    const availableHeight = windowHeight - CHROME_HEIGHT;

    // Constraints
    const MIN_SIDEBAR_WIDTH = 250;
    const MIN_VIDEO_HEIGHT = 200;
    const MIN_SUBTITLE_HEIGHT = 100;
    const MIN_DEFINITION_HEIGHT = 150;

    if (isResizingLeft.current) {
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(e.clientX, windowWidth * 0.4));
      setLeftPanelWidth(newWidth);
    }
    if (isResizingRight.current) {
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(windowWidth - e.clientX, windowWidth * 0.4));
      setRightPanelWidth(newWidth);
    }
    if (isResizingVideo.current) {
      // Calculate max possible height for video while preserving min space for subtitle & definition
      const maxVideoHeight = Math.max(MIN_VIDEO_HEIGHT, availableHeight - subtitleHeight - MIN_DEFINITION_HEIGHT);
      // Clamp
      const newHeight = Math.min(Math.max(MIN_VIDEO_HEIGHT, videoHeight + e.movementY), maxVideoHeight);
      setVideoHeight(newHeight);
    }
    if (isResizingSubtitle.current) {
      // Calculate max possible height for subtitle while preserving min space for definition (Video is fixed state)
      const maxSubtitleHeight = Math.max(MIN_SUBTITLE_HEIGHT, availableHeight - videoHeight - MIN_DEFINITION_HEIGHT);
      // Clamp
      const newHeight = Math.min(Math.max(MIN_SUBTITLE_HEIGHT, subtitleHeight + e.movementY), maxSubtitleHeight);
      setSubtitleHeight(newHeight);
    }
  }, [videoHeight, subtitleHeight]);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResizing);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [handleMouseMove, stopResizing]);


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

  // --- Click Interceptor for Load Video ---
  const handleLoadVideoClick = (e: React.MouseEvent) => {
    // If in Offline Mode AND model is NOT ready
    if (isOffline && modelStatus !== 'ready') {
      e.preventDefault(); // Stop file picker from opening
      setShowModelAlert(true); // Show custom modal
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
    setErrorMsg(null); // Clear previous errors
    
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
        setIsPlaying(false); // Stop playback when regeneration starts

        // If offline and model not ready, this will likely trigger download events too
        if (isOffline && modelStatus === 'idle') {
            setModelStatus('loading');
        }

        try {
          // Pass the API key if online
          await generateSubtitles(videoFile, (newSegments) => {
               // Only update if this request is still the active one
               if (processingIdRef.current === currentId) {
                   setSubtitles(newSegments);
               }
          }, isOffline, selectedModelId, geminiConfig.apiKey);
          
          if (!isOffline && processingIdRef.current === currentId) {
             setIsProcessing(false);
          }
        } catch (error: any) {
          console.error("Subtitle generation failed", error);
          if (processingIdRef.current === currentId) {
              // Show the specific error from service (e.g. "Browser cannot decode...")
              setErrorMsg(error.message || `Could not generate subtitles (${isOffline ? 'Offline' : 'Online'}).`);
              setIsProcessing(false);
          }
        }
    };

    // Small timeout to ensure UI updates state before heavy processing starts
    const timer = setTimeout(() => {
        processVideoForSubtitles();
    }, 100);

    return () => clearTimeout(timer);

  }, [videoFile, isOffline, selectedModelId, geminiConfig.apiKey]);


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
      // Pass local config and API key to service
      const def = await getWordDefinition(cleanWord, context, isOffline, localLLMConfig, geminiConfig.apiKey);
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
      
      {/* MODEL REQUIREMENT ALERT MODAL */}
      {showModelAlert && (
        <div className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
            <div className="bg-gray-900 border border-yellow-700/50 rounded-xl shadow-2xl w-full max-w-sm p-6 text-center relative animate-in zoom-in-95 duration-200">
                <div className="mx-auto w-12 h-12 bg-yellow-900/30 rounded-full flex items-center justify-center mb-4">
                    <AlertTriangle className="text-yellow-500" size={24} />
                </div>
                <h3 className="text-xl font-bold text-white mb-2">Offline Model Required</h3>
                <p className="text-gray-400 mb-6 text-sm leading-relaxed">
                   Please download the Whisper model from the sidebar before loading a video in offline mode.
                </p>
                <button 
                    onClick={() => setShowModelAlert(false)}
                    className="w-full py-2.5 bg-yellow-600 hover:bg-yellow-500 text-white font-medium rounded-lg transition-colors"
                >
                    I Understand
                </button>
            </div>
        </div>
      )}

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
                    Settings
                </h3>

                {/* TABS */}
                <div className="flex border-b border-gray-700 mb-6">
                    <button 
                        onClick={() => setSettingsTab('local')}
                        className={`flex-1 pb-3 text-sm font-medium transition-colors border-b-2 ${settingsTab === 'local' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                    >
                        <div className="flex items-center justify-center gap-2">
                            <Server size={16} />
                            Local AI (Ollama)
                        </div>
                    </button>
                    <button 
                        onClick={() => setSettingsTab('online')}
                        className={`flex-1 pb-3 text-sm font-medium transition-colors border-b-2 ${settingsTab === 'online' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                    >
                        <div className="flex items-center justify-center gap-2">
                            <Cloud size={16} />
                            Online (Gemini)
                        </div>
                    </button>
                </div>
                
                {/* TAB CONTENT: LOCAL */}
                {settingsTab === 'local' && (
                    <div className="space-y-6">
                        {/* Enable Toggle */}
                        <div className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                            <div className="flex flex-col">
                                <span className="font-medium text-gray-200">Enable Local LLM</span>
                                <span className="text-xs text-gray-500">Use local Ollama for definitions in offline mode</span>
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
                    </div>
                )}

                {/* TAB CONTENT: ONLINE */}
                {settingsTab === 'online' && (
                    <div className="space-y-6">
                        <div className="bg-blue-900/10 border border-blue-900/30 rounded-lg p-4 mb-4">
                            <p className="text-xs text-blue-300">
                                Enter your Google Gemini API Key to use cloud-based transcription and definitions.
                                This key is stored locally in your browser.
                            </p>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Gemini API Key</label>
                            <input 
                                type="password" 
                                value={geminiConfig.apiKey}
                                onChange={(e) => setGeminiConfig(p => ({...p, apiKey: e.target.value}))}
                                className="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none transition-all placeholder-gray-700"
                                placeholder="AIzaSy..."
                            />
                            <p className="text-[10px] text-gray-500 mt-2">
                                Leave blank to attempt using the built-in demo key (if configured in environment).
                            </p>
                        </div>
                    </div>
                )}

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
      <div 
        style={{ width: leftPanelWidth }} 
        className="bg-gray-950 border-r border-gray-800 flex flex-col flex-shrink-0 hidden md:flex transition-none relative"
      >
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

      {/* LEFT RESIZER */}
      <div 
        onMouseDown={startResizingLeft}
        className="w-1 cursor-col-resize bg-gray-800 hover:bg-blue-500 transition-colors z-20 flex-shrink-0 hidden md:block"
        title="Drag to resize transcript"
      />

      {/* CENTER: VIDEO PLAYER AREA */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900 relative">
        
        {/* TOP BAR */}
        <div className="h-16 flex items-center justify-between px-6 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">LingoPlayer AI</h1>
          </div>
          <div className="flex items-center gap-4">
            <label 
                onClick={handleLoadVideoClick}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm font-medium rounded-lg cursor-pointer transition-colors border border-gray-700"
            >
                <Upload size={16} />
                <span>Load Video</span>
                <input type="file" accept=".mp4" onChange={handleFileChange} className="hidden" />
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
          <div 
             style={{ height: videoHeight }}
             className="bg-black flex items-center justify-center relative flex-shrink-0"
          >
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                className="w-full h-full object-contain"
                onClick={togglePlayPause}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={() => setIsPlaying(false)}
                onError={(e) => {
                    // Only show generic error if we don't have a more specific one from service already
                    if (!errorMsg) setErrorMsg("Browser cannot decode this video's audio. The format might be unsupported.");
                }}
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

          {/* VERTICAL RESIZER 1 (Video <-> Subtitles) */}
          <div 
            onMouseDown={startResizingVideo}
            className="h-1 cursor-row-resize bg-gray-800 hover:bg-blue-500 transition-colors z-20 flex-shrink-0 flex items-center justify-center group"
          >
              <GripHorizontal size={12} className="text-gray-600 opacity-0 group-hover:opacity-100" />
          </div>

          {/* 2. DEDICATED SUBTITLE AREA */}
          <div 
             style={{ height: subtitleHeight }}
             className="bg-gray-900 p-6 text-center flex flex-col items-center justify-center flex-shrink-0 overflow-y-auto"
          >
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

          {/* VERTICAL RESIZER 2 (Subtitles <-> Definition) */}
           <div 
            onMouseDown={startResizingSubtitle}
            className="h-1 cursor-row-resize bg-gray-800 hover:bg-blue-500 transition-colors z-20 flex-shrink-0 flex items-center justify-center group"
          >
              <GripHorizontal size={12} className="text-gray-600 opacity-0 group-hover:opacity-100" />
          </div>

          {/* 3. WORD DEFINITION PANEL */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
             <WordDefinitionPanel 
                definition={selectedWord} 
                onAddToVocab={addToVocab}
                isSaved={selectedWord ? vocabulary.some(v => v.word === selectedWord.word) : false}
                isLoading={loadingWord}
             />
          </div>
          
          {/* 4. CONTROLS (Fixed at bottom) */}
          <div className="flex-shrink-0">
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
      </div>

      {/* RIGHT RESIZER */}
      {showVocabSidebar && (
        <div 
            onMouseDown={startResizingRight}
            className="w-1 cursor-col-resize bg-gray-800 hover:bg-blue-500 transition-colors z-20 flex-shrink-0 hidden md:block"
            title="Drag to resize vocabulary"
        />
      )}

      {/* RIGHT SIDEBAR: VOCABULARY */}
      {showVocabSidebar && (
        <div 
            style={{ width: rightPanelWidth }}
            className="bg-gray-950 border-l border-gray-800 flex flex-col flex-shrink-0 animate-in slide-in-from-right duration-300 absolute md:static inset-y-0 right-0 z-50 md:z-auto shadow-2xl md:shadow-none transition-none"
        >
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
                    title="Settings"
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