import { WordDefinition } from '../types';

const COMMON_DEFINITIONS: Record<string, Partial<WordDefinition>> = {
  "hello": {
    word: "hello",
    phonetic: "həˈləʊ",
    partOfSpeech: "exclamation",
    meaning: "Used as a greeting or to begin a telephone conversation.",
    usage: "Hello there!",
    example: "Hello, Paul. I haven't seen you for ages."
  },
  "world": {
    word: "world",
    phonetic: "wɜːld",
    partOfSpeech: "noun",
    meaning: "The earth, together with all of its countries, peoples, and natural features.",
    usage: "The world is round.",
    example: "He wants to travel the world."
  },
  "video": {
    word: "video",
    phonetic: "ˈvɪd.i.əʊ",
    partOfSpeech: "noun",
    meaning: "The recording, reproducing, or broadcasting of moving visual images.",
    usage: "Watch the video.",
    example: "We rented a video for the evening."
  },
  "player": {
    word: "player",
    phonetic: "ˈpleɪ.ər",
    partOfSpeech: "noun",
    meaning: "A person who plays a game or sport.",
    usage: "A tennis player.",
    example: "He is a key player in the industry."
  },
  "run": {
    word: "run",
    phonetic: "rʌn",
    partOfSpeech: "verb",
    meaning: "Move at a speed faster than a walk, never having both or all the feet on the ground at the same time.",
    usage: "She runs every morning.",
    example: "I have to run to catch the bus."
  },
  "time": {
    word: "time",
    phonetic: "taɪm",
    partOfSpeech: "noun",
    meaning: "The indefinite continued progress of existence and events in the past, present, and future.",
    usage: "Time flies.",
    example: "Do you have time for a coffee?"
  }
};

export const lookupWord = async (word: string, context: string): Promise<WordDefinition> => {
  // Simulate network delay for realism
  await new Promise(resolve => setTimeout(resolve, 500));

  const lowerWord = word.toLowerCase().trim();
  const entry = COMMON_DEFINITIONS[lowerWord];

  if (entry) {
    return {
      word: entry.word!,
      phonetic: entry.phonetic!,
      partOfSpeech: entry.partOfSpeech!,
      meaning: entry.meaning!,
      usage: entry.usage || context, // Fallback to provided context if static usage missing
      example: entry.example!
    } as WordDefinition;
  }

  // Fallback for words not in our tiny database
  return {
    word: word,
    phonetic: "/.../",
    partOfSpeech: "unknown",
    meaning: "Definition not available in the offline demo dictionary.",
    usage: context,
    example: "Example unavailable offline."
  };
};

export const speakText = (text: string) => {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel(); // Stop previous
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
  }
};