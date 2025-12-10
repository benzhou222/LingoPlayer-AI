export interface SubtitleSegment {
  id: number;
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface WordDefinition {
  word: string;
  phonetic: string;
  partOfSpeech: string;
  meaning: string;
  usage: string;
  example: string;
}

export interface VocabularyItem extends WordDefinition {
  id: string;
  addedAt: number;
}

export enum PlaybackMode {
  CONTINUOUS = 'CONTINUOUS',
  LOOP_SENTENCE = 'LOOP_SENTENCE'
}

export interface LocalLLMConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
}

export interface LocalASRConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
}

export interface GeminiConfig {
  apiKey: string;
}

export type SegmentationMethod = 'fixed' | 'vad';

export interface VADSettings {
  batchSize: number; // Seconds (e.g. 120)
  minSilence: number; // Seconds (e.g. 0.2)
  silenceThreshold: number; // Amplitude (e.g. 0.01)
  filteringEnabled: boolean; // Enable/Disable band-pass filter
}

// Worker Types
export interface WorkerMessage {
  type: 'load' | 'generate' | 'ready' | 'update' | 'complete' | 'error';
  data?: any;
}

export interface WorkerPayload {
  audio: Float32Array;
  sampleRate: number;
}