import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, BookOpen, ListVideo, X, Trash2, AlertCircle, Loader2, WifiOff, Wifi, ToggleLeft, ToggleRight, Download, CheckCircle2, ChevronDown, Settings, RefreshCw, Check, AlertTriangle, GripVertical, GripHorizontal, Cloud, Server, Mic, Terminal, Scissors, PlayCircle, FlaskConical, FileAudio, ExternalLink, Square } from 'lucide-react';
import { SubtitleSegment, WordDefinition, VocabularyItem, PlaybackMode, LocalLLMConfig, GeminiConfig, LocalASRConfig, SegmentationMethod, VADSettings } from './types';
import { generateSubtitles, getWordDefinition, preloadOfflineModel, setLoadProgressCallback, fetchLocalModels, getAudioData, cancelSubtitleGeneration } from './services/geminiService';
import { VideoControls } from './components/VideoControls';
import { WordDefinitionPanel } from './components/WordDefinitionPanel';
import { extractAudioAsWav } from './services/converterService';

const OFFLINE_MODELS = [
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
  const ms = Math.floor((seconds * 1000) % 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
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
  const [processingStatus, setProcessingStatus] = useState<string>(''); // Detailed status
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadingWord, setLoadingWord] = useState(false);
  const [selectedWord, setSelectedWord] = useState<WordDefinition | null>(null);
  const [showVocabSidebar, setShowVocabSidebar] = useState(false);
  
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
  
  // Audio Segmentation State
  const [segmentationMethod, setSegmentationMethod] = useState<SegmentationMethod>(() => {
      try {
          return (localStorage.getItem('lingo_segmentation') as SegmentationMethod) || 'fixed';
      } catch {
          return 'fixed';
      }
  });

  const [vadSettings, setVadSettings] = useState<VADSettings>(() => {
    try {
        const saved = localStorage.getItem('lingo_vad_settings');
        // Updated defaults: minSilence 0.4, silenceThreshold 0.02, filteringEnabled: true
        const defaultSettings = { batchSize: 120, minSilence: 0.4, silenceThreshold: 0.02, filteringEnabled: true };
        return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    } catch {
        return { batchSize: 120, minSilence: 0.4, silenceThreshold: 0.02, filteringEnabled: true };
    }
  });

  // Local LLM State
  const [localLLMConfig, setLocalLLMConfig] = useState<LocalLLMConfig>(() => {
      try {
        const saved = localStorage.getItem('lingo_local_llm');
        return saved ? JSON.parse(saved) : { enabled: false, endpoint: 'http://localhost:11434', model: '' };
      } catch {
        return { enabled: false, endpoint: 'http://localhost:11434', model: '' };
      }
  });

  // Local ASR State (Whisper)
  const [localASRConfig, setLocalASRConfig] = useState<LocalASRConfig>(() => {
      try {
        const saved = localStorage.getItem('lingo_local_asr');
        return saved ? JSON.parse(saved) : { enabled: false, endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions', model: 'whisper-large' };
      } catch {
        return { enabled: false, endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions', model: 'whisper-large' };
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

  // Race condition protection & Audio Cache
  const processingIdRef = useRef(0);
  const audioDataCacheRef = useRef<Float32Array | null>(null);

  // --- Settings Persistence ---
  useEffect(() => {
    localStorage.setItem('lingo_local_llm', JSON.stringify(localLLMConfig));
  }, [localLLMConfig]);

  useEffect(() => {
    localStorage.setItem('lingo_local_asr', JSON.stringify(localASRConfig));
  }, [localASRConfig]);

  useEffect(() => {
    localStorage.setItem('lingo_gemini_config', JSON.stringify(geminiConfig));
  }, [geminiConfig]);

  useEffect(() => {
    localStorage.setItem('lingo_segmentation', segmentationMethod);
  }, [segmentationMethod]);

  useEffect(() => {
    localStorage.setItem('lingo_vad_settings', JSON.stringify(vadSettings));
  }, [vadSettings]);

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

  const applyASRPreset = (preset: string) => {
    if (preset === 'localai') {
        setLocalASRConfig(p => ({
            ...p,
            endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
            model: 'whisper-large'
        }));
    } else if (preset === 'whispercpp') {
        setLocalASRConfig(p => ({
            ...p,
            endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
            model: 'whisper-1'
        }));
    } else if (preset === 'fasterwhisper') {
        setLocalASRConfig(p => ({
            ...p,
            endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
            model: 'large-v3'
        }));
    }
  };

  // --- Click Interceptor for Load Video ---
  const handleLoadVideoClick = (e: React.MouseEvent) => {
     // No blocking here, user can load video anytime
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
    
    // Clear subtitles when loading new file
    setSubtitles([]);
    setCurrentSegmentIndex(-1);
    
    // Clear Audio Cache on new file
    audioDataCacheRef.current = null;
    
    // Set video source for the player
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    
    // Update file state
    setVideoFile(file);
  };

  // Handle Manual Generation
  const handleGenerate = async (testMode: boolean = false) => {
    // START CHANGE: Stop Logic
    if (isProcessing) {
        cancelSubtitleGeneration();
        setIsProcessing(false);
        setProcessingStatus('Stopped.');
        // Invalidate current running job callbacks
        processingIdRef.current += 1;
        return;
    }
    // END CHANGE

    if (!videoFile) return;

    const currentId = processingIdRef.current + 1;
    processingIdRef.current = currentId;

    console.log("%c[Generator] Starting new generation run.", "color: #a78bfa; font-weight: bold;");
    console.log("[Generator] Current VAD Settings:", vadSettings);

    // Reset UI for processing state
    setSubtitles([]);
    setCurrentSegmentIndex(-1);
    setSelectedWord(null);
    setIsProcessing(true);
    setProcessingStatus('Initializing...');
    setErrorMsg(null);
    setIsPlaying(false);

    // If offline and model not ready and local whisper not enabled
    if (isOffline && !localASRConfig.enabled && modelStatus === 'idle') {
        setModelStatus('loading');
    }

    try {
        // --- AUDIO CACHING STRATEGY ---
        let audioDataForProcess = audioDataCacheRef.current;
        
        // If no cache, decode now
        if (!audioDataForProcess) {
             setProcessingStatus('Decoding Audio (Full File)...');
             // We use 'true' for 'forOffline' because we always want raw float32 for caching/VAD, 
             // regardless of mode (Online mode logic will re-encode to WAV if needed inside generateSubtitles)
             const decoded = await getAudioData(videoFile, true);
             if (typeof decoded !== 'string') {
                 audioDataForProcess = decoded;
                 audioDataCacheRef.current = decoded;
             }
        } else {
             console.log("[Generator] Using cached Raw Audio Data (decoding skipped). VAD will re-run on this data.");
        }

        await generateSubtitles(
            videoFile, 
            (newSegments) => {
                // Only update if this request is still the active one
                if (processingIdRef.current === currentId) {
                    setSubtitles(newSegments);
                }
            }, 
            isOffline, 
            selectedModelId, 
            geminiConfig.apiKey, 
            localASRConfig, 
            segmentationMethod, 
            vadSettings,
            testMode,
            audioDataForProcess, // Pass cached data
            (status) => {
                if (processingIdRef.current === currentId) {
                    setProcessingStatus(status);
                }
            }
        );
        
        if (processingIdRef.current === currentId) {
            if (!isOffline || localASRConfig.enabled) {
                setIsProcessing(false);
                setProcessingStatus('');
            }
        }
    } catch (error: any) {
        console.error("Subtitle generation failed", error);
        if (processingIdRef.current === currentId) {
            setErrorMsg(error.message || `Could not generate subtitles (${isOffline ? 'Offline' : 'Online'}).`);
            setIsProcessing(false);
            setProcessingStatus('');
        }
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
      
      {/* SETTINGS MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md p-6 relative animate-in zoom-in-95 duration-200 overflow-y-auto max-h-[90vh]">
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
                            Local AI
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
                
                {/* GLOBAL: AUDIO SEGMENTATION SETTINGS */}
                <div className="mb-8 border-b border-gray-800 pb-6">
                     <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider flex items-center gap-2 pb-2 mb-3">
                        <Scissors size={14} /> Audio Segmentation
                    </h4>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <button
                            onClick={() => setSegmentationMethod('fixed')}
                            className={`flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all ${
                                segmentationMethod === 'fixed' 
                                ? 'bg-blue-900/30 border-blue-500 text-blue-300' 
                                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750'
                            }`}
                        >
                            <span className="font-semibold text-xs mb-1">Progressive (Fixed)</span>
                            <span className="text-[10px] opacity-70">Manual splits (20s, 60s...) for faster initial load.</span>
                        </button>

                        <button
                            onClick={() => setSegmentationMethod('vad')}
                            className={`flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all ${
                                segmentationMethod === 'vad' 
                                ? 'bg-blue-900/30 border-blue-500 text-blue-300' 
                                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750'
                            }`}
                        >
                            <span className="font-semibold text-xs mb-1">VAD (Auto)</span>
                            <span className="text-[10px] opacity-70">Detects silence to split audio at sentence breaks.</span>
                        </button>
                    </div>
                    
                    {/* VAD SETTINGS */}
                    {segmentationMethod === 'vad' && (
                        <div className="space-y-4 px-1">
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Pre-split Batch Duration</label>
                                    <span className="text-xs text-blue-400 font-mono">{vadSettings.batchSize}s</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="10" 
                                    max="600" 
                                    step="10"
                                    value={vadSettings.batchSize}
                                    onChange={(e) => setVadSettings(p => ({ ...p, batchSize: parseInt(e.target.value) }))}
                                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                />
                                <p className="text-[10px] text-gray-500 mt-1">Processing window size. Larger = better context but slower updates.</p>
                            </div>
                            
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Min Silence Duration</label>
                                    <span className="text-xs text-blue-400 font-mono">{vadSettings.minSilence}s</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0.1" 
                                    max="1.0" 
                                    step="0.05"
                                    value={vadSettings.minSilence}
                                    onChange={(e) => setVadSettings(p => ({ ...p, minSilence: parseFloat(e.target.value) }))}
                                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                />
                                <p className="text-[10px] text-gray-500 mt-1">Minimum silence required to trigger a split.</p>
                            </div>

                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Silence Threshold</label>
                                    <span className="text-xs text-blue-400 font-mono">{vadSettings.silenceThreshold}</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0.001" 
                                    max="0.05" 
                                    step="0.001"
                                    value={vadSettings.silenceThreshold}
                                    onChange={(e) => setVadSettings(p => ({ ...p, silenceThreshold: parseFloat(e.target.value) }))}
                                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                />
                                <p className="text-[10px] text-gray-500 mt-1">Sensitivity. Lower = cleaner audio needed. Higher = tolerates noise.</p>
                            </div>

                            {/* Filtering Toggle */}
                             <div className="flex items-center justify-between pt-2 border-t border-gray-800 mt-2">
                                <div>
                                    <div className="text-xs font-bold text-gray-500 uppercase">Vocal Filtering</div>
                                    <p className="text-[10px] text-gray-500">Band-pass filter (150-3000Hz) to isolate voice.</p>
                                </div>
                                <button 
                                    onClick={() => setVadSettings(p => ({...p, filteringEnabled: !p.filteringEnabled}))}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${vadSettings.filteringEnabled ? 'bg-blue-600' : 'bg-gray-700'}`}
                                >
                                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${vadSettings.filteringEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* TAB CONTENT: LOCAL */}
                {settingsTab === 'local' && (
                    <div className="space-y-8">
                        
                        {/* 1. WHISPER ASR SECTION */}
                        <div className="space-y-4">
                            <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider flex items-center gap-2 pb-2 border-b border-gray-800">
                                <Mic size={14} /> Speech-to-Text (Whisper)
                            </h4>
                            
                            {/* Enable Toggle for Local Server */}
                            <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-800">
                                <div className="flex flex-col">
                                    <span className="font-medium text-gray-200 text-sm">Use Local Whisper Server</span>
                                    <span className="text-[10px] text-gray-500">Connect to local server (e.g. Whisper.cpp)</span>
                                </div>
                                <button 
                                    onClick={() => setLocalASRConfig(p => ({...p, enabled: !p.enabled}))}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localASRConfig.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
                                >
                                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${localASRConfig.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                                </button>
                            </div>

                             {/* Configuration for Local Server */}
                            <div className={`transition-opacity duration-200 ${localASRConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                                <div className="mb-4">
                                     <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Server Presets</label>
                                     <div className="relative">
                                        <select 
                                            onChange={(e) => applyASRPreset(e.target.value)}
                                            className="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none appearance-none cursor-pointer"
                                            defaultValue=""
                                        >
                                            <option value="" disabled>Select a server type...</option>
                                            <option value="fasterwhisper">Faster-Whisper-Server (Port 8080) - Recommended for VAD</option>
                                            <option value="whispercpp">Whisper.cpp Server (Port 8080) - Lightweight</option>
                                            <option value="localai">LocalAI (Port 8080) - General Purpose</option>
                                        </select>
                                        <ChevronDown size={14} className="absolute right-3 top-3 text-gray-500 pointer-events-none" />
                                    </div>
                                    <p className="text-[10px] text-blue-400 mt-2">
                                        Tip: "Faster-Whisper-Server" includes VAD to automatically remove silence.
                                    </p>
                                </div>

                                <div className="mb-3">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">API Endpoint</label>
                                    <input 
                                        type="text" 
                                        value={localASRConfig.endpoint}
                                        onChange={(e) => setLocalASRConfig(p => ({...p, endpoint: e.target.value}))}
                                        className="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none transition-all placeholder-gray-700"
                                        placeholder="http://127.0.0.1:8080/v1/audio/transcriptions"
                                    />
                                    <p className="text-[10px] text-gray-500 mt-2">
                                        Supports OpenAI-compatible endpoints (e.g. /v1/audio/transcriptions).
                                    </p>
                                </div>
                                
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Model Name</label>
                                    <input 
                                        type="text" 
                                        value={localASRConfig.model}
                                        onChange={(e) => setLocalASRConfig(p => ({...p, model: e.target.value}))}
                                        className="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none transition-all placeholder-gray-700"
                                        placeholder="whisper-large"
                                    />
                                    <p className="text-[10px] text-gray-500 mt-2">
                                        Server-side model identifier (e.g. large-v3).
                                    </p>
                                </div>

                                {/* HELP: DOCKER COMMAND FOR FASTER WHISPER */}
                                {localASRConfig.endpoint.includes('8080') && localASRConfig.model === 'large-v3' && (
                                    <div className="mt-4 p-3 bg-gray-950 rounded border border-gray-800 text-xs font-mono text-gray-400 overflow-x-auto">
                                        <div className="flex items-center gap-2 text-gray-500 font-sans font-bold mb-2">
                                            <Terminal size={12} />
                                            <span>Run in Docker (NVIDIA GPU):</span>
                                        </div>
                                        <code className="whitespace-pre select-all text-[10px] text-green-500/80 block">
{`docker run --gpus all -d -p 8080:8000 \\
  -v faster_whisper_cache:/root/.cache/huggingface \\
  --name faster-whisper \\
  -e WHISPER_MODEL=large-v3 \\
  -e WHISPER_VAD_FILTER=true \\
  -e WHISPER_VAD_PARAMETERS='{"min_silence_duration_ms": 500}' \\
  -e ALLOW_ORIGINS='["*"]' \\
  fedirz/faster-whisper-server:latest-cuda`}
                                        </code>
                                        <div className="mt-2 text-gray-600 italic">
                                            Note: Maps host port 8080 to container 8000.
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* BROWSER MODEL MANAGER (Visible if Local Server is DISABLED) */}
                            {!localASRConfig.enabled && (
                                <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex flex-col">
                                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">In-Browser Model</span>
                                            <span className="text-[10px] text-gray-500">Runs locally in browser via WebAssembly</span>
                                        </div>
                                        {modelStatus === 'ready' && <CheckCircle2 size={16} className="text-green-500" />}
                                    </div>
                                    
                                    <div className="mb-3 relative">
                                        <select 
                                            value={selectedModelId}
                                            onChange={(e) => handleModelChange(e.target.value)}
                                            className="w-full bg-black text-gray-200 text-xs border border-gray-700 rounded px-2 py-2 appearance-none focus:outline-none focus:border-blue-500 cursor-pointer"
                                            disabled={modelStatus === 'loading'}
                                        >
                                            {OFFLINE_MODELS.map(model => (
                                                <option key={model.id} value={model.id}>{model.name}</option>
                                            ))}
                                        </select>
                                        <ChevronDown size={14} className="absolute right-3 top-3 text-gray-500 pointer-events-none" />
                                    </div>
                                    
                                    {modelStatus === 'idle' && (
                                        <button 
                                            onClick={handlePreloadModel}
                                            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs py-2 rounded transition-colors font-medium shadow-lg shadow-blue-900/20"
                                        >
                                            <Download size={14} />
                                            <span>Download & Load Model</span>
                                        </button>
                                    )}

                                    {modelStatus === 'loading' && (
                                        <div className="space-y-2 bg-black/50 p-2 rounded border border-gray-800">
                                            <div className="flex items-center gap-2 text-xs text-blue-400">
                                                <Loader2 size={12} className="animate-spin" />
                                                <span>{downloadProgress ? `Downloading... ${Math.round(downloadProgress.progress)}%` : 'Initializing...'}</span>
                                            </div>
                                            {downloadProgress && (
                                                <div className="h-1.5 w-full bg-gray-700 rounded-full overflow-hidden">
                                                    <div 
                                                        className="h-full bg-blue-500 transition-all duration-300" 
                                                        style={{ width: `${downloadProgress.progress}%` }} 
                                                    />
                                                </div>
                                            )}
                                            <div className="text-[10px] text-gray-500 truncate" title={downloadProgress?.file}>
                                                {downloadProgress?.file || "Preparing environment..."}
                                            </div>
                                        </div>
                                    )}

                                    {modelStatus === 'ready' && (
                                        <div className="text-xs text-gray-400 flex items-center gap-2">
                                            <CheckCircle2 size={12} className="text-green-500" />
                                            Model cached and ready for use.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>


                        {/* 2. OLLAMA LLM SECTION */}
                        <div className="space-y-4">
                            <h4 className="text-sm font-bold text-gray-400 uppercase tracking-wider flex items-center gap-2 pb-2 border-b border-gray-800">
                                <Server size={14} /> Text Generation (Ollama)
                            </h4>

                            {/* Enable Toggle */}
                            <div className="flex items-center justify-between p-3 bg-gray-800/30 rounded-lg border border-gray-800">
                                <div className="flex flex-col">
                                    <span className="font-medium text-gray-200 text-sm">Use Local Ollama</span>
                                    <span className="text-[10px] text-gray-500">Use local LLM for word definitions</span>
                                </div>
                                <button 
                                    onClick={() => setLocalLLMConfig(p => ({...p, enabled: !p.enabled}))}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localLLMConfig.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
                                >
                                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${localLLMConfig.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                                </button>
                            </div>

                            {/* Configuration Fields */}
                            <div className={`space-y-4 transition-opacity duration-200 ${localLLMConfig.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
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
                                </div>
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
            
            {/* ACTION BUTTONS */}
            <div className="flex items-center gap-2">
                <button 
                    onClick={() => handleGenerate(false)}
                    disabled={!videoFile}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-bold rounded transition-colors shadow-lg shadow-blue-900/20 ${
                        isProcessing 
                        ? 'bg-red-600 hover:bg-red-500 text-white' 
                        : 'bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 text-white'
                    }`}
                >
                    {isProcessing ? <Square size={14} fill="currentColor" /> : <PlayCircle size={14} />}
                    <span>{isProcessing ? 'Stop' : 'Generate'}</span>
                </button>
                <button 
                    onClick={() => handleGenerate(true)}
                    disabled={isProcessing || !videoFile || segmentationMethod !== 'vad'}
                    title={segmentationMethod !== 'vad' ? "Enable VAD mode in settings to test" : "Generate only the first batch (e.g. 2 mins)"}
                    className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-300 text-xs font-bold rounded transition-colors border border-gray-700"
                >
                    <FlaskConical size={14} />
                    <span>Test VAD</span>
                </button>
            </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-0 scroll-smooth relative">
          {subtitles.length === 0 && isProcessing ? (
             <div className="p-8 flex flex-col items-center gap-3 text-gray-500 text-sm">
                <div className="w-5 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-center">
                  {processingStatus ? (
                      <span className="text-blue-400 font-medium animate-pulse">{processingStatus}</span>
                  ) : (
                      isOffline ? (
                          localASRConfig.enabled 
                          ? "Processing with Local Whisper Server..." 
                          : `Running ${OFFLINE_MODELS.find(m => m.id === selectedModelId)?.name.split(' ')[0]} Model...`
                      ) : "Processing with Gemini Cloud..."
                  )}
                </span>
                <span className="text-xs text-gray-600 mt-1">
                    {segmentationMethod === 'vad' ? "Using Smart VAD Splitting" : "Using Progressive Splitting"}
                </span>
            </div>
          ) : subtitles.length === 0 && !isProcessing ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              {errorMsg ? (
                <div className="text-red-400 text-left whitespace-pre-wrap">{errorMsg}</div>
              ) : (
                <span className="opacity-60">
                    {videoFile ? "Ready to generate." : "Load a video to start."}
                </span>
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
          <div className="flex items-center gap-3">
            
            <label 
                onClick={handleLoadVideoClick}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm font-medium rounded-lg cursor-pointer transition-colors border border-gray-700"
            >
                <Upload size={16} />
                <span>Load Video</span>
                <input type="file" accept=".mp4" onChange={handleFileChange} className="hidden" />
            </label>

            <div className="w-px h-6 bg-gray-800 mx-1"></div>

            <button
                onClick={() => { setSettingsTab('local'); setIsSettingsOpen(true); }}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
                title="Settings"
            >
                <Settings size={20} />
            </button>

            <button 
                onClick={() => setShowVocabSidebar(!showVocabSidebar)}
                className={`p-2 rounded-lg transition-colors ${showVocabSidebar ? 'text-blue-400 bg-blue-900/20' : 'text-gray-400 hover:text-white'}`}
                title="Toggle Vocabulary Sidebar"
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
                    // Only show generic error if we don't have an more specific one from service already
                    if (!errorMsg) setErrorMsg("Browser cannot decode this video's audio. The format might be unsupported.");
                }}
                playsInline
              />
            ) : (
              <label 
                  onClick={handleLoadVideoClick}
                  className="text-gray-600 flex flex-col items-center cursor-pointer hover:text-gray-400 transition-colors"
              >
                  <Upload size={48} className="mb-4 opacity-50" />
                  <p className="font-medium text-lg">Click to Load Video</p>
                  <p className="text-xs text-gray-500 mt-2">
                     {isOffline ? "Ready for Offline Mode" : "Ready for Online Mode"}
                  </p>
                  <input type="file" accept=".mp4" onChange={handleFileChange} className="hidden" />
              </label>
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
                       {isOffline ? (
                           localASRConfig.enabled ? "Analyzing Audio (Local Whisper)..." : `Analyzing Audio (${OFFLINE_MODELS.find(m => m.id === selectedModelId)?.name.split(' ')[0]})...`
                       ) : "Analyzing Audio (Gemini Cloud)..."}
                     </span>
                     <span className="text-gray-600 text-xs">
                        {isOffline ? (localASRConfig.enabled ? "Processing on Local Server." : "Running locally on your device.") : "Uploading and processing in the cloud."}
                     </span>
                </div>
             ) : errorMsg ? (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 px-4 py-2 rounded">
                    <AlertCircle size={16} />
                    <span>{errorMsg}</span>
                </div>
             ) : null}
             
             {/* Active Subtitle Overlay (if any) */}
             {currentSegmentIndex !== -1 && subtitles[currentSegmentIndex] && (
                 <div className="animate-in fade-in slide-in-from-bottom-2 duration-200 w-full flex justify-center">
                     <p className="text-xl md:text-2xl font-medium text-white leading-relaxed max-w-3xl text-center">
                         {renderInteractiveSubtitle(subtitles[currentSegmentIndex].text)}
                     </p>
                 </div>
             )}
          </div>

          {/* VERTICAL RESIZER 2 (Subtitle <-> Definition) */}
          <div 
            onMouseDown={startResizingSubtitle}
            className="h-1 cursor-row-resize bg-gray-800 hover:bg-blue-500 transition-colors z-20 flex-shrink-0 flex items-center justify-center group"
          >
              <GripHorizontal size={12} className="text-gray-600 opacity-0 group-hover:opacity-100" />
          </div>

          {/* 3. DEFINITION PANEL */}
          <div className="flex-1 min-h-0 bg-gray-950 overflow-hidden flex flex-col">
             <WordDefinitionPanel 
                definition={selectedWord}
                onAddToVocab={addToVocab}
                isSaved={selectedWord ? vocabulary.some(v => v.word === selectedWord.word) : false}
                isLoading={loadingWord}
                onWordSearch={handleWordClick}
             />
          </div>

        </div>

        {/* BOTTOM CONTROLS */}
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

      {/* RIGHT RESIZER */}
      <div 
        onMouseDown={startResizingRight}
        className="w-1 cursor-col-resize bg-gray-800 hover:bg-blue-500 transition-colors z-20 flex-shrink-0 hidden md:block"
        title="Drag to resize vocabulary"
      />

      {/* RIGHT SIDEBAR: VOCABULARY */}
      {showVocabSidebar && (
        <div 
           style={{ width: rightPanelWidth }}
           className="bg-gray-950 border-l border-gray-800 flex flex-col flex-shrink-0 hidden md:flex"
        >
           <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                 <BookOpen className="text-blue-500" />
                 <h2 className="font-bold text-lg">Vocabulary</h2>
              </div>
           </div>
           
           <div className="flex-1 overflow-y-auto p-0">
              {vocabulary.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-sm opacity-60">
                   <p>No words saved yet.</p>
                   <p className="text-xs mt-2">Click words in subtitles to define and add them.</p>
                </div>
              ) : (
                vocabulary.map((item) => (
                  <div 
                    key={item.id} 
                    onClick={() => handleVocabItemClick(item)}
                    className="p-4 border-b border-gray-800 group hover:bg-gray-900 cursor-pointer transition-colors"
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-bold text-white text-lg">{item.word}</span>
                      <button 
                        onClick={(e) => removeFromVocab(e, item.id)}
                        className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                       <span className="italic">{item.partOfSpeech}</span>
                       <span>•</span>
                       <span className="font-mono text-blue-400">/{item.phonetic}/</span>
                    </div>
                    <p className="text-sm text-gray-400 line-clamp-2">{item.meaning}</p>
                  </div>
                ))
              )}
           </div>
        </div>
      )}
      
    </div>
  );
}