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
