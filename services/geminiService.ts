import { SubtitleSegment, WordDefinition, LocalLLMConfig, LocalASRConfig } from "../types";
import { lookupWord, speakText } from "../utils/dictionary";
import { GoogleGenAI, Type } from "@google/genai";
import { extractAudioAsWav } from "./converterService";

// --- OFFLINE WORKER CODE ---
const WORKER_CODE = `
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

class PipelineFactory {
    static task = 'automatic-speech-recognition';
    static instances = {};

    static async getInstance(modelId, progress_callback = null) {
        if (!this.instances[modelId]) {
            console.log("Loading Whisper model: " + modelId);
            this.instances[modelId] = await pipeline(this.task, modelId, {
                progress_callback
            });
            console.log("Whisper model loaded: " + modelId);
        }
        return this.instances[modelId];
    }
}

self.onmessage = async (event) => {
    const message = event.data;

    if (message.type === 'load') {
        const { model } = message.data;
        try {
            await PipelineFactory.getInstance(model, (data) => {
                self.postMessage({ type: 'progress', data });
            });
            self.postMessage({ type: 'ready' });
        } catch (error) {
            self.postMessage({ type: 'error', data: error.message });
        }
        return;
    }

    if (message.type === 'generate') {
        const { audio, model, jobId } = message.data;
        // Whisper expects 16kHz audio
        const SAMPLE_RATE = 16000;
        // Process in 30-second chunks (standard Whisper window)
        const CHUNK_LENGTH_S = 30;
        const CHUNK_SIZE = CHUNK_LENGTH_S * SAMPLE_RATE;
        
        try {
            const transcriber = await PipelineFactory.getInstance(model, (data) => {
                 self.postMessage({ type: 'progress', data });
            });
            
            const totalSamples = audio.length;
            let offsetSamples = 0;
            
            // Loop through audio in chunks
            while (offsetSamples < totalSamples) {
                const endSamples = Math.min(offsetSamples + CHUNK_SIZE, totalSamples);
                const chunk = audio.slice(offsetSamples, endSamples);
                
                // Run inference on this chunk
                // We don't use the pipeline's built-in chunking/stride for the whole file 
                // because we want immediate partial feedback.
                const output = await transcriber(chunk, {
                    language: 'english',
                    return_timestamps: true,
                });

                // Adjust timestamps relative to the whole file
                const timeOffset = offsetSamples / SAMPLE_RATE;
                
                const adjustedChunks = (output.chunks || []).map(c => {
                    const start = (c.timestamp[0] === null ? 0 : c.timestamp[0]) + timeOffset;
                    const end = (c.timestamp[1] === null ? start + 2 : c.timestamp[1]) + timeOffset;
                    return {
                        text: c.text,
                        timestamp: [start, end]
                    };
                });

                // Emit partial results immediately with jobId
                self.postMessage({ type: 'partial', data: adjustedChunks, jobId });

                offsetSamples += CHUNK_SIZE;
            }

            self.postMessage({ type: 'complete', jobId });

        } catch (error) {
            self.postMessage({ type: 'error', data: error.message, jobId });
        }
    }
};
`;

// --- OFFLINE WORKER MANAGER ---
let worker: Worker | null = null;
let onSubtitleProgressCallback: ((segments: SubtitleSegment[]) => void) | null = null;
let onLoadProgressCallback: ((data: any) => void) | null = null;
let accumulatedSegments: SubtitleSegment[] = [];
let activeJobId = 0; // Track the current generation job

const initWorker = () => {
  if (!worker) {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl, { type: 'module' });
    
    worker.onmessage = (event) => {
      const { type, data, jobId } = event.data;
      
      // If this message belongs to a specific job (generation), check if it's still active
      if (typeof jobId === 'number' && jobId !== activeJobId) {
          // Ignore stale messages from previous runs
          return;
      }

      if (type === 'progress') {
          if (onLoadProgressCallback) onLoadProgressCallback(data);
      } 
      else if (type === 'ready') {
        if (onLoadProgressCallback) onLoadProgressCallback({ status: 'ready' });
      } 
      else if (type === 'partial') {
        // Append new chunks to our local accumulator
        const newSegments: SubtitleSegment[] = (data || []).map((chunk: any, index: number) => ({
           id: accumulatedSegments.length + index,
           start: chunk.timestamp[0],
           end: chunk.timestamp[1],
           text: chunk.text.trim()
        }));
        
        // Filter out empty or extremely short hallucinations
        const validSegments = newSegments.filter(s => s.text.length > 1);
        
        if (validSegments.length > 0) {
            accumulatedSegments = [...accumulatedSegments, ...validSegments];
            if (onSubtitleProgressCallback) onSubtitleProgressCallback(accumulatedSegments);
        }
      }
      else if (type === 'complete') {
        // Final sanity check or cleanup if needed
        if (onSubtitleProgressCallback) onSubtitleProgressCallback(accumulatedSegments);
      } 
      else if (type === 'error') {
        console.error("Worker Error:", data);
        if (onLoadProgressCallback) onLoadProgressCallback({ status: 'error', error: data });
        // Only show alert if it's a general error, not a cancelled job error
        if (!data.file && typeof data === 'string') alert("Offline AI Error: " + data); 
      }
    };
  }
  return worker;
};

// --- AUDIO UTILITIES ---
const getAudioData = async (videoFile: File, forOffline: boolean): Promise<Float32Array | string> => {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        const arrayBuffer = await videoFile.arrayBuffer();
        
        // Try native decoding first
        try {
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            if (forOffline) {
                return audioBuffer.getChannelData(0);
            } else {
                const pcmData = audioBuffer.getChannelData(0);
                const wavBuffer = encodeWAV(pcmData, 16000);
                return blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
            }
        } catch (decodeError) {
            console.warn("Native decoding failed, trying FFmpeg fallback...", decodeError);
            
            // Fallback: Use FFmpeg to extract audio
            const pcmData = await extractAudioAsWav(videoFile);
            
            if (forOffline) {
                return pcmData;
            } else {
                const wavBuffer = encodeWAV(pcmData, 16000);
                return blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
            }
        }
    } catch (e: any) {
        console.error("All audio decoding methods failed:", e);
        throw new Error(e.message || "Unable to decode audio data. The file format might be corrupted or unsupported.");
    }
};

function encodeWAV(samples: Float32Array, sampleRate: number) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (view: DataView, offset: number, string: string) => {
        for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
             const base64String = (reader.result as string).split(',')[1];
             resolve(base64String);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// --- ONLINE MODE IMPLEMENTATION ---
let aiInstance: GoogleGenAI | null = null;

const getAI = (apiKey?: string) => {
    // If a specific key is provided (from UI settings), use it immediately
    if (apiKey) {
        return new GoogleGenAI({ apiKey });
    }

    // Fallback/Legacy logic
    if (!aiInstance) {
        // Lazily access process.env to prevent ReferenceError in browser/offline modes
        // @ts-ignore
        const key = typeof process !== 'undefined' ? process.env.API_KEY : '';
        if (!key) console.warn("API Key not found. Online mode will fail.");
        aiInstance = new GoogleGenAI({ apiKey: key });
    }
    return aiInstance;
};

const generateSubtitlesOnline = async (file: File, apiKey?: string): Promise<SubtitleSegment[]> => {
    const base64Audio = await getAudioData(file, false) as string;
    
    const response = await getAI(apiKey).models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
            parts: [
                { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
                { text: `Transcribe this audio into subtitles. 
                         Strictly output a JSON array of objects. 
                         Each object must have: "start" (number, seconds), "end" (number, seconds), and "text" (string).
                         Group words into complete, meaningful sentences. Do not fragment sentences.` 
                }
            ]
        },
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        start: { type: Type.NUMBER },
                        end: { type: Type.NUMBER },
                        text: { type: Type.STRING }
                    }
                }
            }
        }
    });

    if (response.text) {
        const raw = JSON.parse(response.text);
        return raw.map((item: any, i: number) => ({ ...item, id: i }));
    }
    return [];
};

const getWordDefinitionOnline = async (word: string, context: string, apiKey?: string): Promise<WordDefinition> => {
    const response = await getAI(apiKey).models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Define the word "${word}" based on this context: "${context}".
                   Return JSON with: word, phonetic (IPA), partOfSpeech, meaning, usage (short usage in context), example (a new example sentence).`,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    word: { type: Type.STRING },
                    phonetic: { type: Type.STRING },
                    partOfSpeech: { type: Type.STRING },
                    meaning: { type: Type.STRING },
                    usage: { type: Type.STRING },
                    example: { type: Type.STRING }
                }
            }
        }
    });
    
    if (response.text) {
        return JSON.parse(response.text) as WordDefinition;
    }
    throw new Error("Failed to parse definition");
};

// --- LOCAL LLM IMPLEMENTATION ---
export const fetchLocalModels = async (endpoint: string): Promise<string[]> => {
    try {
        const baseUrl = endpoint.replace(/\/$/, '');
        const response = await fetch(`${baseUrl}/api/tags`);
        if (!response.ok) throw new Error('Failed to connect to Local LLM');
        const data = await response.json();
        return data.models.map((m: any) => m.name);
    } catch (e) {
        console.error("Local LLM Fetch Error:", e);
        throw e;
    }
};

const getLocalLLMDefinition = async (word: string, context: string, config: LocalLLMConfig): Promise<WordDefinition> => {
    const baseUrl = config.endpoint.replace(/\/$/, '');
    
    // Prompt engineered for generic LLMs like Llama 3
    const prompt = `Define the word "${word}" based on this context: "${context}".
    Return a JSON object with exactly these keys:
    - word (string)
    - phonetic (string, IPA format)
    - partOfSpeech (string)
    - meaning (string)
    - usage (string, short usage based on context)
    - example (string, a new example sentence)
    
    Output valid JSON only. Do not include markdown or explanations.`;

    try {
        const response = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.model,
                prompt: prompt,
                stream: false,
                format: "json" 
            })
        });

        const data = await response.json();
        const text = data.response;
        return JSON.parse(text) as WordDefinition;
    } catch (e) {
        console.error("Local LLM Generation Error:", e);
        throw new Error("Failed to get definition from Local LLM");
    }
};


// --- LOCAL ASR (WHISPER) IMPLEMENTATION ---
const generateSubtitlesLocalServer = async (audioData: Float32Array, config: LocalASRConfig): Promise<SubtitleSegment[]> => {
    console.log("Using Local Whisper Server at:", config.endpoint);
    
    // 1. Convert float32 to WAV blob
    const wavBuffer = encodeWAV(audioData, 16000);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const file = new File([blob], "audio.wav", { type: "audio/wav" });

    // 2. Prepare FormData
    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', 'whisper-1'); // Placeholder model name, often ignored or configurable

    // 3. Fetch
    try {
        const response = await fetch(config.endpoint, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Local Server Error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        
        // Handle OpenAI format: { text: "...", segments: [...] }
        if (data.segments && Array.isArray(data.segments)) {
             return data.segments.map((s: any, i: number) => ({
                 id: i,
                 start: s.start,
                 end: s.end,
                 text: s.text.trim()
             }));
        } 
        
        // Handle simple text response (fallback)
        if (data.text) {
             console.warn("Local server returned text only, no segments. Creating single segment.");
             return [{ id: 0, start: 0, end: 9999, text: data.text.trim() }];
        }

        return [];
    } catch (e: any) {
        console.error("Local Whisper Server Failed:", e);
        // Check for specific network errors
        if (e.name === 'TypeError' && e.message === 'Failed to fetch') {
            throw new Error(
                `Connection Failed to ${config.endpoint}.\n` +
                `Possible causes:\n` +
                `1. Server is not running or port is wrong.\n` +
                `2. CORS is not enabled on your local server.\n` +
                `3. Mixed Content Block: If this app is running on HTTPS, browsers block HTTP connections to localhost.\n` +
                `   Solution: Run this app locally via localhost.`
            );
        }
        throw e;
    }
};


// --- MAIN EXPORTS (DISPATCHER) ---

export const generateSubtitles = async (
    videoFile: File, 
    onProgress: (segments: SubtitleSegment[]) => void,
    isOffline: boolean = true,
    modelId: string = 'Xenova/whisper-tiny',
    apiKey?: string,
    localASRConfig?: LocalASRConfig
): Promise<SubtitleSegment[]> => {
    
    if (isOffline) {
        // CHECK LOCAL ASR FIRST
        if (localASRConfig?.enabled && localASRConfig.endpoint) {
             // Reset state logic usually handled by caller, but we can emit empty start
             onProgress([]); 
             
             const audioData = await getAudioData(videoFile, true) as Float32Array;
             const segments = await generateSubtitlesLocalServer(audioData, localASRConfig);
             
             onProgress(segments);
             return segments;
        }

        // BROWSER WASM FALLBACK
        // Reset accumulation for new run
        accumulatedSegments = [];
        onSubtitleProgressCallback = onProgress;
        
        // Start new job ID
        activeJobId++;
        const currentJobId = activeJobId;
        
        const w = initWorker();
        const audioData = await getAudioData(videoFile, true) as Float32Array;
        
        // Check if job is still active after audio extraction (which can take time)
        if (currentJobId !== activeJobId) return [];

        w.postMessage({ type: 'generate', data: { audio: audioData, model: modelId, jobId: currentJobId } });
        return []; // Progress handled via callback
    } else {
        const segments = await generateSubtitlesOnline(videoFile, apiKey);
        onProgress(segments);
        return segments;
    }
};

export const getWordDefinition = async (
    word: string, 
    contextSentence: string,
    isOffline: boolean = true,
    localLLMConfig?: LocalLLMConfig,
    apiKey?: string
): Promise<WordDefinition> => {
    if (isOffline) {
        if (localLLMConfig?.enabled && localLLMConfig.endpoint && localLLMConfig.model) {
            try {
                return await getLocalLLMDefinition(word, contextSentence, localLLMConfig);
            } catch (e) {
                console.warn("Local LLM failed, falling back to static dictionary", e);
                return lookupWord(word, contextSentence);
            }
        }
        return lookupWord(word, contextSentence);
    } else {
        return getWordDefinitionOnline(word, contextSentence, apiKey);
    }
};

export const playAudio = async (textOrBase64: string) => {
    speakText(textOrBase64);
};

// --- MODEL MANAGEMENT EXPORTS ---
export const preloadOfflineModel = (modelId: string = 'Xenova/whisper-tiny') => {
    const w = initWorker();
    w.postMessage({ type: 'load', data: { model: modelId } });
};

export const setLoadProgressCallback = (callback: (data: any) => void) => {
    onLoadProgressCallback = callback;
};