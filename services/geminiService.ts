import { SubtitleSegment, WordDefinition, LocalLLMConfig, LocalASRConfig, SegmentationMethod, VADSettings } from "../types";
import { GoogleGenAI, Type } from "@google/genai";
import { extractAudioAsWav } from "./converterService";
import { lookupWord, speakText } from "../utils/dictionary";
import JSZip from "jszip";

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
            this.instances[modelId] = await pipeline(this.task, modelId, {
                progress_callback
            });
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
        const { audio, model, jobId, timeOffset: globalTimeOffset } = message.data;
        // Whisper expects 16kHz audio
        const SAMPLE_RATE = 16000;
        // Process in 30-second chunks (standard Whisper window)
        const CHUNK_LENGTH_S = 30;
        const CHUNK_SIZE = CHUNK_LENGTH_S * SAMPLE_RATE;
        const globalOffset = globalTimeOffset || 0;
        
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
                
                // Adjust timestamps relative to the whole file (plus global offset if streaming)
                const currentChunkOffset = offsetSamples / SAMPLE_RATE;
                const totalOffset = globalOffset + currentChunkOffset;
                
                // Run inference on this chunk
                const output = await transcriber(chunk, {
                    language: 'english',
                    return_timestamps: true
                });
                
                const adjustedChunks = (output.chunks || []).map(c => {
                    const start = (c.timestamp[0] === null ? 0 : c.timestamp[0]) + totalOffset;
                    const end = (c.timestamp[1] === null ? start + 2 : c.timestamp[1]) + totalOffset;
                    return {
                        text: c.text,
                        timestamp: [start, end]
                    };
                });

                // Emit partial results immediately (Chunk complete)
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

export const cancelSubtitleGeneration = () => {
    activeJobId++;
};

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
        // Append new chunks to our local accumulator with filtering
        const rawSegments = (data || []).map((chunk: any) => ({
           id: 0, 
           start: chunk.timestamp[0],
           end: chunk.timestamp[1],
           text: chunk.text.trim()
        }));

        // 1. Filter out known hallucinations and bad segments
        const validSegments = rawSegments.filter((s: SubtitleSegment) => {
             if (!s.text) return false;
             
             const t = s.text.toLowerCase().trim();
             // Whisper hallucinations
             if (t === 'you' || t === 'thank you' || t === 'thanks for watching' || t.includes('subtitle by') || t === '.') return false;
             
             // Tiny duration with long text is suspicious
             if ((s.end - s.start) < 0.1 && t.length > 5) return false;
             
             return true;
        });

        // 2. Deduplicate and Merge
        for (const seg of validSegments) {
             const last = accumulatedSegments[accumulatedSegments.length - 1];
             if (last) {
                  // Exact text match -> skip
                  if (seg.text === last.text) continue;

                  // Normalize for fuzzy match
                  const cleanSeg = seg.text.toLowerCase().replace(/[.,?!]/g, '').trim();
                  const cleanLast = last.text.toLowerCase().replace(/[.,?!]/g, '').trim();

                  // Partial overlap at the end (e.g., "Hello world" -> "world")
                  if (cleanSeg.length > 2 && cleanLast.endsWith(cleanSeg)) continue;
                  
                  // Timestamp overlap adjustment
                  if (seg.start < last.end) {
                      // If overlap is small, adjust start
                      if (last.end - seg.start < 0.5) {
                          seg.start = last.end;
                      } 
                      // If overlap is large or contained, check content length
                      else if (seg.end <= last.end) {
                          // Contained segment with different text? Skip to be safe
                          continue;
                      }
                  }
             }

             if (seg.end > seg.start) {
                 accumulatedSegments.push(seg);
             }
        }
        
        // Re-assign IDs and sort
        accumulatedSegments.sort((a, b) => a.start - b.start);
        accumulatedSegments = accumulatedSegments.map((s, i) => ({ ...s, id: i }));

        if (onSubtitleProgressCallback) onSubtitleProgressCallback(accumulatedSegments);
      }
      else if (type === 'complete') {
        if (onSubtitleProgressCallback) onSubtitleProgressCallback(accumulatedSegments);
      } 
      else if (type === 'error') {
        if (onLoadProgressCallback) onLoadProgressCallback({ status: 'error', error: data });
        if (!data.file && typeof data === 'string') alert("Offline AI Error: " + data); 
      }
    };
  }
  return worker;
};

// --- AUDIO UTILITIES ---
export const getAudioData = async (videoFile: File, forOffline: boolean): Promise<Float32Array | string> => {
    try {
        const targetSampleRate = 16000;
        // Use AudioContext to decode. It automatically handles container formats (mp4, webm, etc) supported by browser.
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: targetSampleRate });
        const arrayBuffer = await videoFile.arrayBuffer();
        
        // Internal helper to process buffer
        const processDecodedBuffer = async (decoded: AudioBuffer) => {
            let monoData: Float32Array;

            // Perform robust downmixing if multiple channels exist
            if (decoded.numberOfChannels > 1) {
                // Use OfflineAudioContext for fast and correct native downmixing
                const offlineCtx = new OfflineAudioContext(1, decoded.length, targetSampleRate);
                const source = offlineCtx.createBufferSource();
                source.buffer = decoded;
                source.connect(offlineCtx.destination);
                source.start();
                const renderedBuffer = await offlineCtx.startRendering();
                monoData = renderedBuffer.getChannelData(0);
            } else {
                monoData = decoded.getChannelData(0);
            }

            if (forOffline) {
                return monoData;
            } else {
                const wavBuffer = encodeWAV(monoData, targetSampleRate);
                return blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
            }
        };

        try {
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            return await processDecodedBuffer(audioBuffer);
        } catch (decodeError) {
            // Fallback to FFmpeg if browser decode fails (e.g. MKV AC3)
            console.warn("Browser decode failed, trying FFmpeg fallback...", decodeError);
            const pcmData = await extractAudioAsWav(videoFile);
            
            if (forOffline) {
                return pcmData;
            } else {
                const wavBuffer = encodeWAV(pcmData, targetSampleRate);
                return blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
            }
        }
    } catch (e: any) {
        throw e;
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

// Helper: Save Zip
async function saveDebugZip(zip: JSZip) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `lingoplayer_vad_debug_${timestamp}.zip`;

        console.log("[Debug] Generating ZIP file...");
        const blob = await zip.generateAsync({type: "blob"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        
        console.log(`%c[Debug] VAD Processed Audio Saved!`, "color: #10b981; font-weight: bold; font-size: 14px;");
        console.log(`%cFilename: ${filename}`, "color: #34d399;");
        console.log(`%cLocation: Browser Downloads Folder (Exact path hidden by browser security)`, "color: #34d399;");
    } catch (e) {
        console.error("Failed to generate/save debug zip", e);
    }
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
function detectTimeScale(segments: any[], chunkDuration: number): number {
    const parsed = segments.map(s => {
        const start = parseTimestamp(s.start);
        const end = parseTimestamp(s.end);
        return { start, end, dur: end - start };
    }).filter(s => s.end > s.start && s.dur > 0);

    if (parsed.length === 0) return 1.0;
    const avgDur = parsed.reduce((sum, s) => sum + s.dur, 0) / parsed.length;
    const maxEnd = Math.max(...parsed.map(s => s.end));
    const candidates = [1.0, 0.01, 0.001];

    const validCandidates = candidates.filter(scale => {
        const scaledAvg = avgDur * scale;
        const scaledMax = maxEnd * scale;
        const isDurationReasonable = scaledAvg >= 0.2 && scaledAvg <= 30.0;
        const fitsInChunk = scaledMax <= (chunkDuration * 1.5);
        return isDurationReasonable && fitsInChunk;
    });

    if (validCandidates.length === 1) return validCandidates[0];
    if (validCandidates.length > 1) {
        return validCandidates.sort((a, b) => {
            const distA = Math.abs((avgDur * a) - 3.0);
            const distB = Math.abs((avgDur * b) - 3.0);
            return distA - distB;
        })[0];
    }
    return candidates.sort((a, b) => {
         const distA = Math.abs((maxEnd * a) - chunkDuration);
         const distB = Math.abs((maxEnd * b) - chunkDuration);
         return distA - distB;
    })[0];
}

// --- CHUNK GENERATION UTILS (FIXED vs VAD) ---

interface ChunkDefinition {
    index: number;
    start: number;
    end: number;
}

// 1. RMS Calculation
const calculateRMS = (buffer: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
};

// 2. Band-Pass Filter (Isolate Vocals)
// 60Hz HPF + 6000Hz LPF (Widened to prevent cutting speech)
const applyVocalFilter = (audio: Float32Array, sampleRate: number): Float32Array => {
    const filtered = new Float32Array(audio.length);
    const dt = 1 / sampleRate;
    
    // High Pass (60Hz) - Remove deep rumble
    const rc_hp = 1 / (2 * Math.PI * 60);
    const alpha_hp = rc_hp / (rc_hp + dt);
    
    // Low Pass (6000Hz) - Remove high hiss but keep fricatives
    const rc_lp = 1 / (2 * Math.PI * 6000);
    const alpha_lp = dt / (rc_lp + dt);

    let lastIn = 0;
    let lastOutHp = 0;
    let lastOutLp = 0;

    for (let i = 0; i < audio.length; i++) {
        // HPF
        const hp = alpha_hp * (lastOutHp + audio[i] - lastIn);
        lastIn = audio[i];
        lastOutHp = hp;

        // LPF
        const lp = lastOutLp + alpha_lp * (hp - lastOutLp);
        filtered[i] = lp;
        lastOutLp = lp;
    }
    
    return filtered;
};

// 3. VAD Scan (Find split points in a buffer)
const scanForSplitPoints = (
    audio: Float32Array, 
    sampleRate: number, 
    minSilenceSec: number, 
    threshold: number
): number[] => {
    const splitPoints: number[] = [];
    const windowSize = Math.floor(sampleRate * 0.05); // 50ms analysis window
    const minSilenceSamples = minSilenceSec * sampleRate;
    
    let currentSilenceSamples = 0;
    let silenceStartIndex = -1;

    for (let i = 0; i < audio.length; i += windowSize) {
        const end = Math.min(i + windowSize, audio.length);
        const window = audio.subarray(i, end);
        const rms = calculateRMS(window);

        if (rms < threshold) {
            // Silence detected
            if (currentSilenceSamples === 0) {
                silenceStartIndex = i;
            }
            currentSilenceSamples += (end - i);
        } else {
            // Speech detected - check if previous silence was a valid split point
            if (currentSilenceSamples >= minSilenceSamples) {
                // Split in the middle of the silence
                const splitPoint = silenceStartIndex + Math.floor(currentSilenceSamples / 2);
                splitPoints.push(splitPoint);
            }
            // Reset
            currentSilenceSamples = 0;
            silenceStartIndex = -1;
        }
    }

    // Handle trailing silence if valid
    if (currentSilenceSamples >= minSilenceSamples) {
         const splitPoint = silenceStartIndex + Math.floor(currentSilenceSamples / 2);
         splitPoints.push(splitPoint);
    }

    return splitPoints;
};

// 4. Main VAD Generator (Pre-Split -> Filter -> VAD)
function* getVADChunks(
    audioData: Float32Array, 
    sampleRate: number, 
    batchSizeSec: number, 
    minSilenceSec: number, 
    silenceThreshold: number, 
    filteringEnabled: boolean, 
    limitSec?: number
): Generator<ChunkDefinition> {
    console.log(`%c[VAD] Fresh Start - Clearing state and re-scanning...`, "color: #f59e0b; font-weight: bold; font-size: 1.1em;");
    console.log(`%c[VAD] Settings: Batch=${batchSizeSec}s | MinSilence=${minSilenceSec}s | Threshold=${silenceThreshold} | Filter=${filteringEnabled}`, "color: #60a5fa");

    const BATCH_SAMPLES = batchSizeSec * sampleRate;
    let filePointer = 0;
    let globalIndex = 0;
    
    // Buffer to hold audio that needs processing (including carried over audio)
    // IMPORTANT: Re-initialized here, ensuring no cache from previous runs.
    let buffer: Float32Array = new Float32Array(0);
    // Track the global start time of the current buffer
    let bufferGlobalStart = 0;

    while (filePointer < audioData.length) {
        if (limitSec !== undefined && (filePointer / sampleRate) >= limitSec) {
             console.log(`%c[VAD] Test Limit (${limitSec}s) reached. Stopping.`, "color: orange");
             break;
        }

        // --- STEP 1: PRE-SPLIT (Batching) ---
        const batchEnd = Math.min(filePointer + BATCH_SAMPLES, audioData.length);
        const newBatch = audioData.slice(filePointer, batchEnd);
        
        console.groupCollapsed(`[VAD] Processing Batch ${(filePointer/sampleRate).toFixed(2)}s - ${(batchEnd/sampleRate).toFixed(2)}s`);
        
        // Merge leftover buffer with new batch
        const combined = new Float32Array(buffer.length + newBatch.length);
        combined.set(buffer);
        combined.set(newBatch, buffer.length);
        buffer = combined;
        // bufferGlobalStart is already correct (points to start of leftover)
        
        console.log(`Buffer size: ${(buffer.length/sampleRate).toFixed(2)}s (Leftover + New Batch)`);

        // --- STEP 2: FILTERING ---
        let analysisBuffer = buffer;
        if (filteringEnabled) {
            console.log(`Applying Band-Pass Filter (60Hz - 6000Hz)...`);
            analysisBuffer = applyVocalFilter(buffer, sampleRate);
        } else {
            console.log(`Filtering Disabled. Analyzing Raw Audio.`);
        }

        // --- STEP 3: VAD SCAN ---
        console.log(`Scanning for silence (Threshold: ${silenceThreshold}, Min: ${minSilenceSec}s)...`);
        const splitIndices = scanForSplitPoints(analysisBuffer, sampleRate, minSilenceSec, silenceThreshold);
        console.log(`Found ${splitIndices.length} split points.`);

        // --- STEP 4: YIELD CHUNKS ---
        let lastSplitLocal = 0;
        
        for (const splitPoint of splitIndices) {
            const startLocal = lastSplitLocal;
            const endLocal = splitPoint;
            
            // Validate chunk size (avoid < 0.2s unless it's the only option)
            const dur = (endLocal - startLocal) / sampleRate;
            
            if (dur > 0.2) {
                const globalStart = bufferGlobalStart + startLocal;
                const globalEnd = bufferGlobalStart + endLocal;
                
                console.log(`Yielding Chunk #${globalIndex}: ${globalStart/sampleRate}s -> ${globalEnd/sampleRate}s (${dur.toFixed(2)}s)`);
                
                yield {
                    index: globalIndex++,
                    start: globalStart,
                    end: globalEnd
                };
            } else {
                console.debug(`Skipping micro-chunk (<0.2s): ${dur.toFixed(3)}s`);
            }
            
            lastSplitLocal = endLocal;
        }

        // --- STEP 5: HANDLE LEFTOVERS ---
        const isEOF = batchEnd >= audioData.length;
        const isLimitReached = limitSec !== undefined && (batchEnd / sampleRate) >= limitSec;
        
        // Calculate remaining audio in buffer
        const leftoverSamples = buffer.length - lastSplitLocal;

        if (isEOF || isLimitReached) {
            // Flush Everything
            if (leftoverSamples > 0) {
                 const globalStart = bufferGlobalStart + lastSplitLocal;
                 const globalEnd = bufferGlobalStart + buffer.length;
                 console.log(`EOF: Flushing final chunk: ${globalStart/sampleRate}s -> ${globalEnd/sampleRate}s`);
                 yield {
                    index: globalIndex++,
                    start: globalStart,
                    end: globalEnd
                 };
            }
            buffer = new Float32Array(0);
        } else {
            // Check if buffer is getting dangerously large (no silence found)
            // e.g., if buffer > 3 * batchSize, we must cut forcefully to avoid memory issues or hanging
            const MAX_BUFFER_SAMPLES = BATCH_SAMPLES * 3;
            
            if (leftoverSamples > MAX_BUFFER_SAMPLES) {
                console.warn(`%cBuffer too large (${(leftoverSamples/sampleRate).toFixed(2)}s) without silence! Forcing split.`, "color: red");
                
                const globalStart = bufferGlobalStart + lastSplitLocal;
                const globalEnd = bufferGlobalStart + buffer.length;
                
                yield {
                    index: globalIndex++,
                    start: globalStart,
                    end: globalEnd
                };
                
                // Reset buffer completely
                buffer = new Float32Array(0);
                // The next buffer start will be exactly where we just ended (which is the current batchEnd)
                bufferGlobalStart = batchEnd; 
            } else {
                // Normal carry over
                console.log(`Carrying over ${(leftoverSamples/sampleRate).toFixed(2)}s to next batch.`);
                buffer = buffer.slice(lastSplitLocal);
                bufferGlobalStart = bufferGlobalStart + lastSplitLocal;
            }
        }
        
        console.groupEnd();
        filePointer = batchEnd;
        if (isLimitReached) break;
    }
    console.log(`%c[VAD] Completed. Total Chunks: ${globalIndex}`, "color: #4ade80; font-weight: bold;");
}

// Split Audio using Fixed Progressive Schedule (Generator Version)
function* getFixedChunks(audioData: Float32Array, sampleRate: number, limitSec?: number): Generator<ChunkDefinition> {
    // Progressive Chunking Strategy: 0s-20s, 20s-1m, 1m-3m, then 3m chunks
    const CHUNK_SCHEDULE_ENDS = [20, 60, 180]; 
    const STANDARD_CHUNK_DURATION = 180;

    const totalSamples = audioData.length;
    let currentSampleOffset = 0;
    let scheduleIndex = 0;
    let globalIndex = 0;

    while (currentSampleOffset < totalSamples) {
        // Limit Check for Test Mode
        if (limitSec !== undefined && (currentSampleOffset / sampleRate) >= limitSec) {
            break;
        }

        let chunkEndSamples;
        
        if (scheduleIndex < CHUNK_SCHEDULE_ENDS.length) {
             const endSeconds = CHUNK_SCHEDULE_ENDS[scheduleIndex];
             chunkEndSamples = Math.floor(endSeconds * sampleRate);
             if (chunkEndSamples <= currentSampleOffset) {
                 chunkEndSamples = currentSampleOffset + (STANDARD_CHUNK_DURATION * sampleRate);
             }
        } else {
             chunkEndSamples = currentSampleOffset + (STANDARD_CHUNK_DURATION * sampleRate);
        }
        
        chunkEndSamples = Math.min(chunkEndSamples, totalSamples);
        if (chunkEndSamples <= currentSampleOffset) break;

        yield {
            index: globalIndex++,
            start: currentSampleOffset,
            end: chunkEndSamples
        };
        
        currentSampleOffset = chunkEndSamples;
        scheduleIndex++;
    }
}

const getChunkDefinitions = (audioData: Float32Array, sampleRate: number, method: SegmentationMethod, vadSettings: VADSettings, limitSec?: number): Generator<ChunkDefinition> => {
    if (method === 'vad') {
        return getVADChunks(audioData, sampleRate, vadSettings.batchSize, vadSettings.minSilence, vadSettings.silenceThreshold, vadSettings.filteringEnabled, limitSec);
    }
    return getFixedChunks(audioData, sampleRate, limitSec);
};


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

const generateSubtitlesOnline = async (
    file: File, 
    apiKey: string | undefined, 
    onProgress: (segments: SubtitleSegment[]) => void,
    segmentationMethod: SegmentationMethod,
    vadSettings: VADSettings,
    testMode: boolean,
    cachedAudioData?: Float32Array,
    onStatus?: (status: string) => void,
    jobId?: number
): Promise<SubtitleSegment[]> => {
    if (!apiKey && (!process.env.API_KEY || process.env.API_KEY === '')) {
         throw new Error("API Key is missing. Please enter your Gemini API Key in Settings.");
    }

    let audioData: Float32Array;
    if (cachedAudioData) {
        audioData = cachedAudioData;
    } else {
        if (onStatus) onStatus("Decoding Audio (Full File)...");
        const data = await getAudioData(file, true);
        if (typeof data === 'string') {
             // Should not happen with getAudioData(..., true) but for type safety:
             throw new Error("Received string data for VAD processing.");
        }
        audioData = data;
    }

    if (onStatus) onStatus("Analyzing Audio Structure...");

    const SAMPLE_RATE = 16000;
    
    // Determine limit
    const limitSec = testMode ? vadSettings.batchSize : undefined;

    // Get chunks generator
    const chunkGenerator = getChunkDefinitions(audioData, SAMPLE_RATE, segmentationMethod, vadSettings, limitSec);

    const resultsMap: Record<number, SubtitleSegment[]> = {};
    let maxIndexFound = -1;
    
    // Test Mode: Initialize ZIP
    const zip = testMode ? new JSZip() : null;
    
    const updateProgress = () => {
        let allSegments: SubtitleSegment[] = [];
        // Since chunks come in order mostly, but we process in parallel, 
        // we can iterate up to the max index we have processed so far.
        for (let i = 0; i <= maxIndexFound; i++) {
            if (resultsMap[i]) {
                allSegments = allSegments.concat(resultsMap[i]);
            }
        }
        if (allSegments.length > 0) {
            allSegments.sort((a, b) => a.start - b.start);
            onProgress(allSegments.map((s, i) => ({ ...s, id: i })));
        }
    };

    const processChunk = async (chunkDef: ChunkDefinition) => {
        const chunkSamples = audioData.slice(chunkDef.start, chunkDef.end);
        const wavBuffer = encodeWAV(chunkSamples, SAMPLE_RATE);

        // --- DEBUG: SAVE CHUNK TO ZIP ---
        if (testMode && zip) {
             const startTime = (chunkDef.start / SAMPLE_RATE).toFixed(2);
             const endTime = (chunkDef.end / SAMPLE_RATE).toFixed(2);
             const fileName = `chunk_${chunkDef.index.toString().padStart(3, '0')}_${startTime}s-${endTime}s.wav`;
             zip.file(fileName, wavBuffer);
        }
        // ---------------------------------------------------------------------

        const base64Audio = await blobToBase64(new Blob([wavBuffer], { type: 'audio/wav' }));
        const timeOffset = chunkDef.start / SAMPLE_RATE;
        const actualDuration = chunkSamples.length / SAMPLE_RATE;

        const ai = getAI(apiKey);
        
        // Strict prompt to ensure no data loss
        const prompt = `Transcribe the audio exactly. Output valid JSON array: [{ "start": float, "end": float, "text": string }]. 
Timestamps must be relative to the start of this clip (0.0). 
Include every spoken word. Do not summarize. Do not skip segments. Verbatim transcription only.`;

        let attempt = 0;
        const MAX_RETRIES = 3;

        while (attempt < MAX_RETRIES) {
            try {
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

                if (response.text) {
                    const rawSegments = JSON.parse(response.text) as {start: number, end: number, text: string}[];
                    const scale = detectTimeScale(rawSegments, actualDuration);
                    const processedSegments = rawSegments.map(s => ({
                        id: 0,
                        start: (parseTimestamp(s.start) * scale) + timeOffset,
                        end: (parseTimestamp(s.end) * scale) + timeOffset,
                        text: s.text.trim()
                    })).filter(s => s.text.length > 0);

                    return processedSegments;
                }
                return [];

            } catch (e: any) {
                attempt++;
                if (attempt >= MAX_RETRIES) return [];
                const delay = Math.pow(2, attempt - 1) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        return [];
    };

    if (onStatus) onStatus("Transcribing Segments...");
    onProgress([]);

    const CONCURRENCY_LIMIT = 2;
    
    // Using a shared iterator for workers allows them to consume chunks as they are yielded by the generator
    const worker = async () => {
        while (true) {
            if (jobId !== undefined && jobId !== activeJobId) break; // Cancellation check

            const { value: chunkDef, done } = chunkGenerator.next();
            if (done) break;
            
            if (jobId !== undefined && jobId !== activeJobId) break; // Double check

            // Track max index for UI rendering purposes
            if (chunkDef.index > maxIndexFound) maxIndexFound = chunkDef.index;
            
            const segs = await processChunk(chunkDef);
            resultsMap[chunkDef.index] = segs;
            updateProgress();
        }
    };

    const workers = [];
    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    
    // Download ZIP if in Test Mode
    if (testMode && zip) {
        await saveDebugZip(zip);
    }

    let finalSegments: SubtitleSegment[] = [];
    // Final pass to ensure everything is collected
    for (let i = 0; i <= maxIndexFound; i++) {
        if (resultsMap[i]) finalSegments = finalSegments.concat(resultsMap[i]);
    }
    return finalSegments.map((s, i) => ({ ...s, id: i }));
};

export const getWordDefinition = async (word: string, context: string, isOffline: boolean, localLLMConfig: LocalLLMConfig, apiKey?: string): Promise<WordDefinition> => {
    if (isOffline) {
        if (localLLMConfig.enabled) {
            return await getLocalLLMDefinition(word, context, localLLMConfig);
        } else {
             return await lookupWord(word, context); 
        }
    } else {
        return await getWordDefinitionOnline(word, context, apiKey);
    }
};

const getWordDefinitionOnline = async (word: string, context: string, apiKey?: string): Promise<WordDefinition> => {
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
        const text = data.response;
        return JSON.parse(text) as WordDefinition;
    } catch (e) {
        throw new Error("Failed to get definition from Local LLM");
    }
};

// --- LOCAL ASR (WHISPER) IMPLEMENTATION ---
export const testLocalWhisperConnection = async (endpoint: string): Promise<boolean> => {
    try {
        await fetch(endpoint, { method: 'OPTIONS', credentials: 'omit' });
        return true; 
    } catch (e: any) {
        try {
             await fetch(endpoint, { method: 'GET', mode: 'no-cors' });
             return true; 
        } catch {
            return false;
        }
    }
};

const generateSubtitlesLocalServer = async (
    audioData: Float32Array, 
    onProgress: (segments: SubtitleSegment[]) => void,
    config: LocalASRConfig,
    segmentationMethod: SegmentationMethod,
    vadSettings: VADSettings,
    testMode: boolean,
    jobId?: number
): Promise<SubtitleSegment[]> => {
    const SAMPLE_RATE = 16000;
    
    // Determine limit (PRE-SPLITTING LIMIT)
    const limitSec = testMode ? vadSettings.batchSize : undefined;

    // Get chunks generator
    const chunkGenerator = getChunkDefinitions(audioData, SAMPLE_RATE, segmentationMethod, vadSettings, limitSec);

    let allSegments: SubtitleSegment[] = [];
    
    // Test Mode: Initialize ZIP
    const zip = testMode ? new JSZip() : null;

    // Local server usually can't handle concurrency well on consumer GPU, so we do sequential
    for (const chunkDef of chunkGenerator) {
        if (jobId !== undefined && jobId !== activeJobId) break; // Cancellation check

        const chunkSamples = audioData.slice(chunkDef.start, chunkDef.end);
        const chunkStartTime = chunkDef.start / SAMPLE_RATE;
        const chunkDuration = chunkSamples.length / SAMPLE_RATE;

        const wavBuffer = encodeWAV(chunkSamples, SAMPLE_RATE);

        // --- DEBUG: SAVE CHUNK TO ZIP ---
        if (testMode && zip) {
             const startTime = chunkStartTime.toFixed(2);
             const endTime = (chunkDef.end / SAMPLE_RATE).toFixed(2);
             const fileName = `chunk_${chunkDef.index.toString().padStart(3, '0')}_${startTime}s-${endTime}s.wav`;
             zip.file(fileName, wavBuffer);
        }
        // ---------------------------------------------------------------------

        const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        const file = new File([audioBlob], "chunk.wav", { type: "audio/wav" });
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('model', config.model || 'whisper-1');
        formData.append('response_format', 'verbose_json'); 
        
        try {
            const response = await fetch(config.endpoint, {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                const data = await response.json();
                let rawSegments: any[] = [];
                
                if (data.segments && Array.isArray(data.segments)) {
                    rawSegments = data.segments;
                } else if (Array.isArray(data)) {
                    rawSegments = data;
                } else if (data.text) {
                    rawSegments = [{ start: 0, end: chunkDuration, text: data.text }];
                }

                if (rawSegments.length > 0) {
                    const scale = detectTimeScale(rawSegments, chunkDuration);
                    const chunkSegments: SubtitleSegment[] = rawSegments.map((s: any) => {
                         const startRaw = parseTimestamp(s.start);
                         const endRaw = parseTimestamp(s.end);
                         return {
                             id: 0,
                             start: (startRaw * scale) + chunkStartTime,
                             end: (endRaw * scale) + chunkStartTime,
                             text: s.text?.trim() || ""
                         };
                    }).filter(s => s.text.length > 0);

                    // Merge logic
                    for (const seg of chunkSegments) {
                        const last = allSegments[allSegments.length - 1];
                        if (last) {
                            if (seg.text === last.text) continue;
                            const cleanSeg = seg.text.toLowerCase().trim();
                            const cleanLast = last.text.toLowerCase().trim();
                            if (cleanSeg.length > 3 && cleanLast.endsWith(cleanSeg)) continue;
                            if (seg.start < last.end && last.end - seg.start < 1.0) {
                                seg.start = last.end;
                            }
                        }
                        if (seg.end > seg.start) allSegments.push(seg);
                    }
                    onProgress(allSegments.map((s, i) => ({...s, id: i})));
                }
            }
        } catch (e) {}
    }

    if (testMode && zip) {
        await saveDebugZip(zip);
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
    localASRConfig: LocalASRConfig,
    segmentationMethod: SegmentationMethod,
    vadSettings: VADSettings,
    testMode: boolean = false,
    cachedAudioData?: Float32Array,
    onStatus?: (status: string) => void
): Promise<SubtitleSegment[]> => {
    
    // Start new job
    activeJobId++;
    const jobId = activeJobId;
    
    // Clear accumulation for new run (legacy global var, but used by worker callbacks)
    accumulatedSegments = []; 

    if (!isOffline) {
        return await generateSubtitlesOnline(videoFile, apiKey, onProgress, segmentationMethod, vadSettings, testMode, cachedAudioData, onStatus, jobId);
    }

    let audioData: Float32Array;
    if (cachedAudioData) {
        audioData = cachedAudioData;
    } else {
        if (onStatus) onStatus("Decoding Audio (Full File)...");
        const data = await getAudioData(videoFile, true);
        if (typeof data === 'string') throw new Error("Received string data for offline processing.");
        audioData = data;
    }

    if (onStatus) onStatus("Analyzing Audio Structure...");

    const SAMPLE_RATE = 16000;

    if (localASRConfig.enabled) {
        return await generateSubtitlesLocalServer(audioData, onProgress, localASRConfig, segmentationMethod, vadSettings, testMode, jobId);
    }

    // In-Browser Worker
    // Note: To support VAD here, we must stream chunks to the worker sequentially.
    return new Promise(async (resolve, reject) => {
        const w = initWorker();
        onSubtitleProgressCallback = onProgress;
        
        // Determine limit
        const limitSec = testMode ? vadSettings.batchSize : undefined;

        // Setup chunk generator
        const chunkGenerator = getChunkDefinitions(audioData, SAMPLE_RATE, segmentationMethod, vadSettings, limitSec);
        
        // Test Mode: Initialize ZIP
        const zip = testMode ? new JSZip() : null;

        // We'll process chunks sequentially to avoid overloading the worker memory/queue
        try {
            if (onStatus) onStatus("Running AI Model...");
            for (const chunkDef of chunkGenerator) {
                // Check if job cancelled (simple check: if activeJobId changed)
                if (jobId !== activeJobId) {
                    console.log(`[Offline Job] Job ID ${jobId} cancelled by newer request.`);
                    break;
                }

                const chunkSamples = audioData.slice(chunkDef.start, chunkDef.end);
                const timeOffset = chunkDef.start / SAMPLE_RATE;

                // --- DEBUG: SAVE CHUNK TO ZIP ---
                if (testMode && zip) {
                        const wavBuffer = encodeWAV(chunkSamples, SAMPLE_RATE);
                        const startTime = timeOffset.toFixed(2);
                        const endTime = (chunkDef.end / SAMPLE_RATE).toFixed(2);
                        const fileName = `chunk_${chunkDef.index.toString().padStart(3, '0')}_${startTime}s-${endTime}s.wav`;
                        zip.file(fileName, wavBuffer);
                }
                // ---------------------------------------------------------------------

                // Create a promise for this specific chunk
                await new Promise<void>((chunkResolve, chunkReject) => {
                    const chunkHandler = (e: MessageEvent) => {
                        if (e.data.jobId === jobId) {
                            if (e.data.type === 'complete') {
                                w.removeEventListener('message', chunkHandler);
                                chunkResolve();
                            }
                            if (e.data.type === 'error') {
                                w.removeEventListener('message', chunkHandler);
                                chunkReject(new Error(e.data.data));
                            }
                            // 'partial' events are handled by the global initWorker onmessage
                        }
                    };
                    w.addEventListener('message', chunkHandler);
                    
                    w.postMessage({
                        type: 'generate',
                        data: { audio: chunkSamples, model: modelId, jobId, timeOffset }
                    });
                });
            }
            
            if (testMode && zip) {
                await saveDebugZip(zip);
            }

            resolve(accumulatedSegments);
        } catch (e) {
            reject(e);
        }
    });
};

export const preloadOfflineModel = (modelId: string) => {
  const w = initWorker();
  w.postMessage({ type: 'load', data: { model: modelId } });
};

export const setLoadProgressCallback = (cb: (data: any) => void) => {
  onLoadProgressCallback = cb;
};