import { SubtitleSegment, WordDefinition, LocalLLMConfig, LocalASRConfig } from "../types";
import { GoogleGenAI, Type } from "@google/genai";
import { extractAudioAsWav } from "./converterService";
import { lookupWord, speakText } from "../utils/dictionary";

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
                
                // Adjust timestamps relative to the whole file
                const timeOffset = offsetSamples / SAMPLE_RATE;

                // LOGGING REQUEST: Split 0-20s, 20s-1m, 1m-3m
                let logPrefixReq = "";
                if (timeOffset < 20) logPrefixReq = "[Worker Request 0-20s]";
                else if (timeOffset < 60) logPrefixReq = "[Worker Request 20s-1m]";
                else if (timeOffset < 180) logPrefixReq = "[Worker Request 1m-3m]";

                if (logPrefixReq) {
                    console.log(\`\${logPrefixReq} Processing Chunk starting at \${timeOffset.toFixed(2)}s\`, {
                        inputSampleCount: chunk.length,
                        model: model,
                        language: 'english'
                    });
                }
                
                // Run inference on this chunk
                // We don't use the pipeline's built-in chunking/stride for the whole file 
                // because we want immediate partial feedback.
                const output = await transcriber(chunk, {
                    language: 'english',
                    return_timestamps: true,
                });

                
                const adjustedChunks = (output.chunks || []).map(c => {
                    const start = (c.timestamp[0] === null ? 0 : c.timestamp[0]) + timeOffset;
                    const end = (c.timestamp[1] === null ? start + 2 : c.timestamp[1]) + timeOffset;
                    return {
                        text: c.text,
                        timestamp: [start, end]
                    };
                });

                // LOGGING RESPONSE: Split 0-20s, 20s-1m, 1m-3m
                let logPrefixRes = "";
                if (timeOffset < 20) logPrefixRes = "[Worker Response 0-20s]";
                else if (timeOffset < 60) logPrefixRes = "[Worker Response 20s-1m]";
                else if (timeOffset < 180) logPrefixRes = "[Worker Response 1m-3m]";

                if (logPrefixRes) {
                    console.log(\`\${logPrefixRes} Chunk starting at \${timeOffset.toFixed(2)}s data:\`, adjustedChunks);
                }

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
        const newSegments: SubtitleSegment[] = (data || []).map((chunk: any) => ({
           id: accumulatedSegments.length, // temporary ID
           start: chunk.timestamp[0],
           end: chunk.timestamp[1],
           text: chunk.text.trim()
        }));
        
        // Filter out empty or extremely short hallucinations
        const validSegments = newSegments.filter((s: SubtitleSegment) => s.text.length > 1);
        
        if (validSegments.length > 0) {
            accumulatedSegments = [...accumulatedSegments, ...validSegments];
            // Sort to prevent out of order display during streaming
            accumulatedSegments.sort((a, b) => a.start - b.start);
            // Re-assign IDs
            accumulatedSegments = accumulatedSegments.map((s, i) => ({ ...s, id: i }));
            if (onSubtitleProgressCallback) onSubtitleProgressCallback(accumulatedSegments);
        }
      }
      else if (type === 'complete') {
        if (onSubtitleProgressCallback) onSubtitleProgressCallback(accumulatedSegments);
      } 
      else if (type === 'error') {
        console.error("Worker Error:", data);
        if (onLoadProgressCallback) onLoadProgressCallback({ status: 'error', error: data });
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

// Helper to safely parse potentially weird timestamp formats (for local/legacy parsing)
function parseTimestamp(val: any): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        const v = val.trim();
        if (!v) return 0;

        // Normalize comma decimals (VTT/SRT style: 00:00:10,500)
        const normalized = v.replace(',', '.');

        // Check for colon format (HH:MM:SS or MM:SS)
        if (normalized.includes(':')) {
            const parts = normalized.split(':');
            let seconds = 0;
            if (parts.length === 3) {
                // HH:MM:SS
                seconds = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
            } else if (parts.length === 2) {
                // MM:SS
                seconds = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
            } else {
                 seconds = parseFloat(parts[parts.length - 1]);
            }
            return isNaN(seconds) ? 0 : seconds;
        }

        // Standard float string
        const num = parseFloat(normalized);
        return isNaN(num) ? 0 : num;
    }
    return 0;
}

// Deterministic, calculation-based method to determine timestamp units.
// Avoids estimation by validating against physical speech constraints and chunk limits.
function detectTimeScale(segments: any[], chunkDuration: number): number {
    // 1. Pre-process and calculate internal durations
    const parsed = segments.map(s => {
        const start = parseTimestamp(s.start);
        const end = parseTimestamp(s.end);
        return { start, end, dur: end - start };
    }).filter(s => s.end > s.start && s.dur > 0);

    // If no valid segments, assume standard seconds
    if (parsed.length === 0) return 1.0;

    // Calculate Average Duration of segments in raw units
    const avgDur = parsed.reduce((sum, s) => sum + s.dur, 0) / parsed.length;
    
    // Calculate Max Timestamp in raw units
    const maxEnd = Math.max(...parsed.map(s => s.end));

    // Candidates: Seconds (1.0), Centiseconds (0.01), Milliseconds (0.001)
    const candidates = [1.0, 0.01, 0.001];

    // Filter candidates based on Strict Constraints
    const validCandidates = candidates.filter(scale => {
        const scaledAvg = avgDur * scale;
        const scaledMax = maxEnd * scale;

        // Constraint 1: "Speech Physics"
        // A single subtitle segment is typically between 0.2s (a word) and 15s (a long sentence).
        // We allow up to 30s to be extremely generous for run-on sentences, but anything beyond that is likely a scale error.
        // e.g. if unit is ms, but we treat as s -> 2500s average duration -> invalid.
        // e.g. if unit is s, but we treat as ms -> 0.0025s average duration -> invalid.
        const isDurationReasonable = scaledAvg >= 0.2 && scaledAvg <= 30.0;

        // Constraint 2: "Chunk Bounds"
        // The timestamps cannot exceed the chunk duration significantly.
        // We allow a 50% buffer for model drift/hallucination, but not orders of magnitude.
        const fitsInChunk = scaledMax <= (chunkDuration * 1.5);

        return isDurationReasonable && fitsInChunk;
    });

    console.log(`[Timestamp Calc] RawAvg: ${avgDur}, RawMax: ${maxEnd}, ChunkDur: ${chunkDuration}. Valid Scales: ${validCandidates.join(', ')}`);

    // Decision Logic
    if (validCandidates.length === 1) {
        return validCandidates[0];
    }

    if (validCandidates.length > 1) {
        // If multiple are valid (unlikely, e.g. seconds vs centiseconds?), 
        // pick the one whose average duration is closest to 3.0 seconds (standard sentence).
        return validCandidates.sort((a, b) => {
            const distA = Math.abs((avgDur * a) - 3.0);
            const distB = Math.abs((avgDur * b) - 3.0);
            return distA - distB;
        })[0];
    }

    // Fallback: If NONE are valid (e.g. model hallucinated wild timestamps),
    // pick the one that at least fits inside the chunk duration best.
    return candidates.sort((a, b) => {
         const distA = Math.abs((maxEnd * a) - chunkDuration);
         const distB = Math.abs((maxEnd * b) - chunkDuration);
         return distA - distB;
    })[0];
}

// --- ONLINE MODE IMPLEMENTATION ---
let aiInstance: GoogleGenAI | null = null;

const getAI = (apiKey?: string) => {
    if (apiKey) {
        return new GoogleGenAI({ apiKey });
    }
    if (!aiInstance) {
        // @ts-ignore
        const key = typeof process !== 'undefined' ? process.env.API_KEY : '';
        if (key) {
            aiInstance = new GoogleGenAI({ apiKey: key });
        }
    }
    return aiInstance || new GoogleGenAI({ apiKey: '' });
};

const generateSubtitlesOnline = async (file: File, apiKey: string | undefined, onProgress: (segments: SubtitleSegment[]) => void): Promise<SubtitleSegment[]> => {
    // 1. Explicitly check for API Key
    if (!apiKey && (!process.env.API_KEY || process.env.API_KEY === '')) {
         throw new Error("API Key is missing. Please enter your Gemini API Key in Settings.");
    }

    // 2. Get Raw Audio Data (Float32Array)
    const audioData = await getAudioData(file, true) as Float32Array;
    
    const SAMPLE_RATE = 16000;
    
    // Progressive Chunking Strategy:
    // 1. 0s - 20s (Fastest first paint)
    // 2. 20s - 1m (Medium follow-up)
    // 3. 1m - 3m (Longer context)
    // 4. 3m+ (Standard large chunks of 3 minutes)
    const CHUNK_SCHEDULE_ENDS = [20, 60, 180]; 
    const STANDARD_CHUNK_DURATION = 180; // 3 minutes for subsequent chunks

    const totalSamples = audioData.length;
    
    // Create chunk definitions
    const chunkDefs = [];
    let currentSampleOffset = 0;
    let scheduleIndex = 0;

    while (currentSampleOffset < totalSamples) {
        let chunkEndSamples;
        
        if (scheduleIndex < CHUNK_SCHEDULE_ENDS.length) {
             // Use scheduled absolute end time
             const endSeconds = CHUNK_SCHEDULE_ENDS[scheduleIndex];
             chunkEndSamples = Math.floor(endSeconds * SAMPLE_RATE);
             // Ensure we don't go backwards or get stuck if audio started after schedule
             if (chunkEndSamples <= currentSampleOffset) {
                 chunkEndSamples = currentSampleOffset + (STANDARD_CHUNK_DURATION * SAMPLE_RATE);
             }
        } else {
             // Standard duration
             chunkEndSamples = currentSampleOffset + (STANDARD_CHUNK_DURATION * SAMPLE_RATE);
        }
        
        // Clamp to total duration
        chunkEndSamples = Math.min(chunkEndSamples, totalSamples);
        
        if (chunkEndSamples <= currentSampleOffset) break;

        chunkDefs.push({
            index: chunkDefs.length,
            start: currentSampleOffset,
            end: chunkEndSamples
        });
        
        currentSampleOffset = chunkEndSamples;
        scheduleIndex++;
    }

    // Storage for results (indexed by chunk index)
    const resultsMap: Record<number, SubtitleSegment[]> = {};
    
    // Helper to update progress UI
    const updateProgress = () => {
        let allSegments: SubtitleSegment[] = [];
        // Concat in order of chunks
        for (let i = 0; i < chunkDefs.length; i++) {
            if (resultsMap[i]) {
                allSegments = allSegments.concat(resultsMap[i]);
            }
        }
        
        if (allSegments.length > 0) {
            // Sort segments by start time
            allSegments.sort((a, b) => a.start - b.start);
            // Update UI with re-indexed segments
            onProgress(allSegments.map((s, i) => ({ ...s, id: i })));
        }
    };

    // Helper to process a single chunk
    const processChunk = async (chunkDef: typeof chunkDefs[0]) => {
        console.log(`[Gemini Subtitles] Processing Chunk ${chunkDef.index} (Start: ${chunkDef.start})...`);
        const chunkSamples = audioData.slice(chunkDef.start, chunkDef.end);
        const wavBuffer = encodeWAV(chunkSamples, SAMPLE_RATE);
        const base64Audio = await blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
        const timeOffset = chunkDef.start / SAMPLE_RATE;
        const actualDuration = chunkSamples.length / SAMPLE_RATE;

        const ai = getAI(apiKey);
        const prompt = `Transcribe audio to subtitles in JSON.
Array of objects: { "start": number (seconds), "end": number, "text": string }.
Precision is key. Return start/end relative to the audio clip start (0.0).`;

        let attempt = 0;
        const MAX_RETRIES = 3;

        while (attempt < MAX_RETRIES) {
            try {
                // LOGGING REQUEST: Split 0-20s, 20s-1m, 1m-3m
                let logPrefixReq = "";
                if (timeOffset < 20) logPrefixReq = "[Gemini Request 0-20s]";
                else if (timeOffset < 60) logPrefixReq = "[Gemini Request 20s-1m]";
                else if (timeOffset < 180) logPrefixReq = "[Gemini Request 1m-3m]";

                if (logPrefixReq) {
                    console.log(`${logPrefixReq} Chunk ${chunkDef.index} starting at ${timeOffset}s Sending Payload:`, {
                        model: 'gemini-2.5-flash',
                        prompt: prompt,
                        audioSizeBase64: base64Audio.length,
                        config: { temperature: 0.0, responseMimeType: 'application/json' }
                    });
                }

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [
                        {
                            parts: [
                                { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
                                { text: prompt }
                            ]
                        }
                    ],
                    config: {
                        temperature: 0.0,
                        responseMimeType: 'application/json',
                        responseSchema: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    start: { type: Type.NUMBER },
                                    end: { type: Type.NUMBER },
                                    text: { type: Type.STRING }
                                },
                                required: ["start", "end", "text"]
                            }
                        }
                    }
                });

                // LOGGING RESPONSE: Split 0-20s, 20s-1m, 1m-3m
                let logPrefixRes = "";
                if (timeOffset < 20) logPrefixRes = "[Gemini Response 0-20s]";
                else if (timeOffset < 60) logPrefixRes = "[Gemini Response 20s-1m]";
                else if (timeOffset < 180) logPrefixRes = "[Gemini Response 1m-3m]";

                if (logPrefixRes) {
                     console.log(`${logPrefixRes} Chunk ${chunkDef.index} Response Length: ${response.text?.length || 0} Raw:`, response.text);
                } else {
                     console.log(`[Gemini Subtitles] Chunk ${chunkDef.index} Response Length: ${response.text?.length || 0}`);
                }

                if (response.text) {
                    const rawSegments = JSON.parse(response.text) as {start: number, end: number, text: string}[];
                    
                    // Fix potential timestamp scaling (ms vs s) using calculated method
                    const scale = detectTimeScale(rawSegments, actualDuration);
                    
                    const processedSegments = rawSegments.map(s => ({
                        id: 0, // Assigned later
                        start: (parseTimestamp(s.start) * scale) + timeOffset,
                        end: (parseTimestamp(s.end) * scale) + timeOffset,
                        text: s.text.trim()
                    })).filter(s => s.text.length > 0);

                    return processedSegments;
                }
                return [];

            } catch (e: any) {
                attempt++;
                console.warn(`[Gemini Subtitles] Chunk ${chunkDef.index} failed (Attempt ${attempt}/${MAX_RETRIES})`, e);
                
                // If it's the last attempt, log error and return empty
                if (attempt >= MAX_RETRIES) {
                     console.error(`[Gemini Subtitles] Chunk ${chunkDef.index} permanently failed after ${MAX_RETRIES} attempts.`);
                     return [];
                }
                
                // Exponential backoff: 1s, 2s, 4s
                const delay = Math.pow(2, attempt - 1) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        return [];
    };

    // Report initial status
    onProgress([]);

    // 3. Queue-based Concurrency (Faster "Time to First Byte" than Batching)
    // We allow X concurrent requests. As soon as one finishes, we update UI and start next.
    const CONCURRENCY_LIMIT = 2;
    let nextChunkIndex = 0;

    const worker = async () => {
        while (nextChunkIndex < chunkDefs.length) {
            const currentIdx = nextChunkIndex++;
            const def = chunkDefs[currentIdx];
            
            // Process
            const segs = await processChunk(def);
            
            // Store results
            resultsMap[currentIdx] = segs;
            
            // IMMEDIATE UI UPDATE
            updateProgress();
        }
    };

    // Start workers
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, chunkDefs.length); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    // Final clean pass (ensure everything is consistent)
    let finalSegments: SubtitleSegment[] = [];
    for (let i = 0; i < chunkDefs.length; i++) {
        if (resultsMap[i]) finalSegments = finalSegments.concat(resultsMap[i]);
    }
    return finalSegments.map((s, i) => ({ ...s, id: i }));
};

export const getWordDefinition = async (word: string, context: string, isOffline: boolean, localLLMConfig: LocalLLMConfig, apiKey?: string): Promise<WordDefinition> => {
    if (isOffline) {
        if (localLLMConfig.enabled) {
            return await getLocalLLMDefinition(word, context, localLLMConfig);
        } else {
             return await lookupWord(word, context); // Tiny local dictionary fallback
        }
    } else {
        return await getWordDefinitionOnline(word, context, apiKey);
    }
};

const getWordDefinitionOnline = async (word: string, context: string, apiKey?: string): Promise<WordDefinition> => {
    // Explicitly check for API Key
    if (!apiKey && (!process.env.API_KEY || process.env.API_KEY === '')) {
         throw new Error("API Key is missing. Please enter your Gemini API Key in Settings.");
    }

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
    
    console.log(`[Gemini Definition] Raw response for "${word}":`, response.text);

    if (response.text) {
        return JSON.parse(response.text) as WordDefinition;
    }
    throw new Error("Failed to parse definition");
};

export const playAudio = async (text: string) => {
    speakText(text);
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
        console.log("Local LLM (Ollama) Raw Response:", data);
        const text = data.response;
        return JSON.parse(text) as WordDefinition;
    } catch (e) {
        console.error("Local LLM Generation Error:", e);
        throw new Error("Failed to get definition from Local LLM");
    }
};

// --- LOCAL ASR (WHISPER) IMPLEMENTATION ---
export const testLocalWhisperConnection = async (endpoint: string): Promise<boolean> => {
    try {
        await fetch(endpoint, { 
            method: 'OPTIONS', 
            credentials: 'omit'
        });
        return true; 
    } catch (e: any) {
        console.error("Local Whisper Connection Test Failed:", e);
        try {
             await fetch(endpoint, { method: 'GET', mode: 'no-cors' });
             return true; 
        } catch {
            return false;
        }
    }
};

// Generate subtitles using a local OpenAI-compatible Whisper server
const generateSubtitlesLocalServer = async (
    audioData: Float32Array, 
    onProgress: (segments: SubtitleSegment[]) => void,
    config: LocalASRConfig
): Promise<SubtitleSegment[]> => {
    // PROGRESSIVE CHUNKING: 0-20s, 20s-1m, 1m-3m, then 3m chunks
    // To match user request for fast loading on "Big Model" (Local Whisper)
    const CHUNK_SCHEDULE_ENDS = [20, 60, 180]; 
    const STANDARD_CHUNK_DURATION = 180;
    const SAMPLE_RATE = 16000;

    let allSegments: SubtitleSegment[] = [];
    let offsetSamples = 0;
    let chunkIndex = 0;
    let scheduleIndex = 0;

    console.log(`[LocalASR] Starting transcription. Total samples: ${audioData.length}`);

    while (offsetSamples < audioData.length) {
        let chunkEndSamples;
        
        if (scheduleIndex < CHUNK_SCHEDULE_ENDS.length) {
             const endSeconds = CHUNK_SCHEDULE_ENDS[scheduleIndex];
             chunkEndSamples = Math.floor(endSeconds * SAMPLE_RATE);
             if (chunkEndSamples <= offsetSamples) {
                 chunkEndSamples = offsetSamples + (STANDARD_CHUNK_DURATION * SAMPLE_RATE);
             }
        } else {
             chunkEndSamples = offsetSamples + (STANDARD_CHUNK_DURATION * SAMPLE_RATE);
        }
        
        chunkEndSamples = Math.min(chunkEndSamples, audioData.length);
        if (chunkEndSamples <= offsetSamples) break;

        const chunkSamples = audioData.slice(offsetSamples, chunkEndSamples);
        const chunkStartTime = offsetSamples / SAMPLE_RATE;
        const chunkDuration = chunkSamples.length / SAMPLE_RATE;

        // Encode chunk to WAV
        const wavBuffer = encodeWAV(chunkSamples, SAMPLE_RATE);
        const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        const file = new File([audioBlob], "chunk.wav", { type: "audio/wav" });
        
        // Prepare FormData
        const formData = new FormData();
        formData.append('file', file);
        formData.append('model', config.model || 'whisper-1');
        formData.append('response_format', 'verbose_json'); // Critical: Request segments
        
        try {
            // LOGGING REQUEST: Split 0-20s, 20s-1m, 1m-3m
            let logPrefixReq = "";
            if (chunkStartTime < 20) logPrefixReq = "[LocalASR Request 0-20s]";
            else if (chunkStartTime < 60) logPrefixReq = "[LocalASR Request 20s-1m]";
            else if (chunkStartTime < 180) logPrefixReq = "[LocalASR Request 1m-3m]";

            if (logPrefixReq) {
                 console.log(`${logPrefixReq} Chunk ${chunkIndex} starting at ${formatTime(chunkStartTime)}s Sending Payload:`, {
                     url: config.endpoint,
                     model: config.model,
                     response_format: 'verbose_json',
                     fileSize: file.size
                 });
            } else {
                 console.log(`[LocalASR] Sending Chunk ${chunkIndex} (${formatTime(chunkStartTime)}s)...`);
            }
            
            const response = await fetch(config.endpoint, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`[LocalASR] Chunk ${chunkIndex} failed (${response.status}): ${errText}`);
                // We continue to next chunk to avoid failing entire video
            } else {
                const data = await response.json();
                
                // LOGGING RESPONSE: Split 0-20s, 20s-1m, 1m-3m
                let logPrefixRes = "";
                if (chunkStartTime < 20) logPrefixRes = "[LocalASR Response 0-20s]";
                else if (chunkStartTime < 60) logPrefixRes = "[LocalASR Response 20s-1m]";
                else if (chunkStartTime < 180) logPrefixRes = "[LocalASR Response 1m-3m]";

                if (logPrefixRes) {
                     console.log(`${logPrefixRes} Chunk starting at ${chunkStartTime}s Raw Response:`, data);
                } else {
                     console.log(`[LocalASR] Chunk ${chunkIndex} Response received.`);
                }

                let rawSegments: any[] = [];
                
                if (data.segments && Array.isArray(data.segments)) {
                    rawSegments = data.segments;
                } else if (Array.isArray(data)) {
                    // Some servers return the array directly
                    rawSegments = data;
                } else if (data.text) {
                    // Fallback: If verbose_json ignored, we get full text.
                    rawSegments = [{ start: 0, end: chunkDuration, text: data.text }];
                }

                if (rawSegments.length > 0) {
                    // --- Auto-Detect Timestamp Scale ---
                    // Apply strict detection to local server outputs too
                    const scale = detectTimeScale(rawSegments, chunkDuration);

                    const chunkSegments: SubtitleSegment[] = rawSegments.map((s: any) => {
                         const startRaw = parseTimestamp(s.start);
                         const endRaw = parseTimestamp(s.end);
                         
                         const startRel = startRaw * scale;
                         const endRel = endRaw * scale;

                         // Timestamps are assumed relative to the chunk start
                         return {
                             id: 0,
                             start: startRel + chunkStartTime,
                             end: endRel + chunkStartTime,
                             text: s.text?.trim() || ""
                         };
                    }).filter(s => s.text.length > 0);

                    // --- Deduplication & Merging ---
                    for (const seg of chunkSegments) {
                        const last = allSegments[allSegments.length - 1];
                        if (last) {
                            // 1. Exact Repetition Filter
                            if (seg.text === last.text) continue;
                            
                            // 2. Substring Repetition Filter (common hallucination)
                            // Clean text to compare content
                            const cleanSeg = seg.text.toLowerCase().trim();
                            const cleanLast = last.text.toLowerCase().trim();
                            
                            // If current is short and contained in last, skip
                            if (cleanSeg.length > 3 && cleanLast.endsWith(cleanSeg)) continue;

                            // 3. Fix Overlap
                            if (seg.start < last.end) {
                                // If overlap is small, adjust start
                                if (last.end - seg.start < 1.0) {
                                    seg.start = last.end;
                                }
                            }
                        }
                        
                        if (seg.end > seg.start) {
                            allSegments.push(seg);
                        }
                    }

                    // Update UI incrementally
                    onProgress(allSegments.map((s, i) => ({...s, id: i})));
                }
            }

        } catch (e) {
            console.error(`[LocalASR] Chunk ${chunkIndex} error:`, e);
        }

        offsetSamples = chunkEndSamples;
        scheduleIndex++;
        chunkIndex++;
    }

    return allSegments.map((s, i) => ({ ...s, id: i }));
};

const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
};


// --- ORCHESTRATOR ---
export const generateSubtitles = async (
    videoFile: File, 
    onProgress: (segments: SubtitleSegment[]) => void, 
    isOffline: boolean,
    modelId: string,
    apiKey: string,
    localASRConfig: LocalASRConfig
): Promise<SubtitleSegment[]> => {

    // 1. Online Mode
    if (!isOffline) {
        return await generateSubtitlesOnline(videoFile, apiKey, onProgress);
    }

    // Decode Audio for Offline use
    // We do this once here to share between Local Server and Browser Worker logic
    const audioData = await getAudioData(videoFile, true) as Float32Array;

    // 2. Offline - Local Whisper Server
    if (localASRConfig.enabled) {
        return await generateSubtitlesLocalServer(audioData, onProgress, localASRConfig);
    }

    // 3. Offline - In-Browser Worker
    return new Promise((resolve, reject) => {
        const w = initWorker();
        onSubtitleProgressCallback = onProgress;
        
        accumulatedSegments = [];
        activeJobId++;
        const jobId = activeJobId;

        // Listen for completion
        const completionHandler = (e: MessageEvent) => {
            if (e.data.jobId === jobId) {
                if (e.data.type === 'complete') {
                    w.removeEventListener('message', completionHandler);
                    resolve(accumulatedSegments);
                }
                if (e.data.type === 'error') {
                    w.removeEventListener('message', completionHandler);
                    reject(new Error(e.data.data));
                }
            }
        };
        w.addEventListener('message', completionHandler);

        w.postMessage({
            type: 'generate',
            data: { audio: audioData, model: modelId, jobId }
        });
    });
};

export const preloadOfflineModel = (modelId: string) => {
  const w = initWorker();
  w.postMessage({ type: 'load', data: { model: modelId } });
};

export const setLoadProgressCallback = (cb: (data: any) => void) => {
  onLoadProgressCallback = cb;
};