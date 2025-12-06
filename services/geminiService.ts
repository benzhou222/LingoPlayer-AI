import { GoogleGenAI, Type, Modality } from "@google/genai";
import { SubtitleSegment, WordDefinition } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Constants for audio processing
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_S = 60; // Process 60 seconds at a time to prevent drift
const CHUNK_SIZE = CHUNK_DURATION_S * TARGET_SAMPLE_RATE;

// Helper: Resample AudioBuffer to 16kHz Mono PCM Int16Array
// Async with yielding to prevent UI blocking
const resampleToPCM = async (buffer: AudioBuffer): Promise<Int16Array> => {
  const numChannels = 1; // Mono
  const sourceRate = buffer.sampleRate;
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(buffer.length / ratio);
  
  const pcmData = new Int16Array(outputLength);
  const channelData = buffer.getChannelData(0); // Use left channel
  
  const CHUNK_TIME_MS = 15; // Yield every 15ms
  let startTime = performance.now();
  
  for (let i = 0; i < outputLength; i++) {
    // Linear Interpolation
    const originalIndex = i * ratio;
    const indexFloor = Math.floor(originalIndex);
    const indexCeil = Math.min(indexFloor + 1, channelData.length - 1);
    const weight = originalIndex - indexFloor;
    
    const sample = channelData[indexFloor] * (1 - weight) + channelData[indexCeil] * weight;

    // Float to Int16
    const s = Math.max(-1, Math.min(1, sample));
    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;

    // Yield to main thread
    if (i % 2000 === 0) {
        if (performance.now() - startTime > CHUNK_TIME_MS) {
            await new Promise(resolve => setTimeout(resolve, 0));
            startTime = performance.now();
        }
    }
  }

  return pcmData;
};

// Helper: Wrap PCM data in WAV container and return Base64
const pcmToWavBase64 = (pcmData: Int16Array): Promise<string> => {
    return new Promise((resolve, reject) => {
        try {
            const numChannels = 1;
            const bitDepth = 16;
            // pcmData is likely a subarray, so we use byteLength which reflects the size of the view
            const dataLength = pcmData.byteLength; 
            const bufferLength = 44 + dataLength;
            const arrayBuffer = new ArrayBuffer(bufferLength);
            const view = new DataView(arrayBuffer);

            const writeString = (offset: number, string: string) => {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            };

            // RIFF
            writeString(0, 'RIFF');
            view.setUint32(4, 36 + dataLength, true);
            writeString(8, 'WAVE');
            // fmt
            writeString(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, numChannels, true);
            view.setUint32(24, TARGET_SAMPLE_RATE, true);
            view.setUint32(28, TARGET_SAMPLE_RATE * numChannels * (bitDepth / 8), true);
            view.setUint16(32, numChannels * (bitDepth / 8), true);
            view.setUint16(34, bitDepth, true);
            // data
            writeString(36, 'data');
            view.setUint32(40, dataLength, true);

            // Write PCM
            // CRITICAL FIX: Use byteOffset and byteLength to handle Subarrays correctly.
            // Without this, it tries to copy the entire underlying buffer of the parent array.
            const pcmBytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
            const finalBytes = new Uint8Array(arrayBuffer);
            finalBytes.set(pcmBytes, 44);

            const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result as string;
                if (result) {
                    resolve(result.split(',')[1]);
                } else {
                    reject(new Error("Failed to convert audio to base64"));
                }
            };
            reader.onerror = (e) => reject(e);
            reader.readAsDataURL(blob);
        } catch (e) {
            reject(e);
        }
    });
};

// Robust JSON parsing
const robustParseJSON = (jsonStr: string): any[] => {
  let cleanStr = jsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleanStr);
  } catch (e) {
    // console.warn("Standard JSON parse failed, attempting recovery...");
  }

  try {
    const lastObjectEnd = cleanStr.lastIndexOf('}');
    if (lastObjectEnd === -1) return [];
    let recoveredStr = cleanStr.substring(0, lastObjectEnd + 1);
    if (!recoveredStr.trim().startsWith('[')) recoveredStr = '[' + recoveredStr;
    if (!recoveredStr.trim().endsWith(']')) recoveredStr = recoveredStr + ']';
    return JSON.parse(recoveredStr);
  } catch (e) {
     // console.warn("Array recovery failed, attempting individual object extraction...");
     const objects: any[] = [];
     let balance = 0;
     let start = -1;
     for (let i = 0; i < cleanStr.length; i++) {
        const char = cleanStr[i];
        if (char === '{') {
           if (balance === 0) start = i;
           balance++;
        } else if (char === '}') {
           balance--;
           if (balance === 0 && start !== -1) {
              const substring = cleanStr.substring(start, i + 1);
              try {
                 const obj = JSON.parse(substring);
                 if (obj.start !== undefined && obj.text !== undefined) objects.push(obj);
              } catch(err) {}
              start = -1;
           }
        }
     }
     return objects;
  }
};

export const generateSubtitles = async (
    videoFile: File, 
    onProgress?: (segments: SubtitleSegment[]) => void
): Promise<SubtitleSegment[]> => {
  try {
    // 1. Decode Audio
    await new Promise(resolve => setTimeout(resolve, 50)); // Yield
    const arrayBuffer = await videoFile.arrayBuffer();
    
    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    const audioContext = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });
    
    let audioBuffer: AudioBuffer;
    try {
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    } finally {
        if (audioContext.state !== 'closed') await audioContext.close();
    }

    // 2. Resample to 16kHz PCM
    const pcmData = await resampleToPCM(audioBuffer);

    // 3. Split into Chunks
    const chunks: { data: Int16Array, startTime: number }[] = [];
    for (let i = 0; i < pcmData.length; i += CHUNK_SIZE) {
        chunks.push({
            data: pcmData.subarray(i, Math.min(i + CHUNK_SIZE, pcmData.length)),
            startTime: i / TARGET_SAMPLE_RATE
        });
    }

    // 4. Process Chunks (Sequential or Batched to preserve order and avoid rate limits)
    let allSegments: SubtitleSegment[] = [];
    let globalSegmentId = 0;

    for (const chunk of chunks) {
        // Skip tiny chunks at the end
        if (chunk.data.length < 16000) continue; 

        const base64 = await pcmToWavBase64(chunk.data);
        
        // REFINED PROMPT: Strictly enforced sentence-level segmentation
        const prompt = `
          You are an expert subtitle transcriber.
          Task: Transcribe the audio chunk and split it into **complete sentences** or **meaningful phrases**.

          STRICT RULES:
          1. **DO NOT** output single words as segments. You MUST group words into natural phrases (e.g., 5-20 words).
          2. **DO NOT** reset timestamps to 0 for every word.
          3. Only break segments at natural pauses, punctuation, or ends of sentences.
          4. If the audio is cut off at the start/end, transcribe the partial phrase available.
          5. Return raw JSON array ONLY. No Markdown.

          Example of Correct Output:
          [
            { "start": 0.5, "end": 4.2, "text": "This is a complete sentence with multiple words." },
            { "start": 4.5, "end": 8.1, "text": "And this is the next sentence, properly grouped." }
          ]
        `;

        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: {
            parts: [
              { inlineData: { mimeType: "audio/wav", data: base64 } },
              { text: prompt }
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                },
                required: ["start", "end", "text"],
              },
            },
          },
        });

        const rawSegments = robustParseJSON(response.text || "[]");
        
        // Adjust timestamps and add to list
        const adjustedSegments = rawSegments
            .filter((seg: any) => seg.text && seg.text.trim().length > 0) // Filter empty
            .map((seg: any) => ({
                id: globalSegmentId++,
                start: seg.start + chunk.startTime,
                end: seg.end + chunk.startTime,
                text: seg.text
            }));

        // Emit progress if callback provided
        if (onProgress && adjustedSegments.length > 0) {
            onProgress(adjustedSegments);
        }

        allSegments = [...allSegments, ...adjustedSegments];
        
        // Small delay between requests to be nice to API
        await new Promise(r => setTimeout(r, 200));
    }

    return allSegments;

  } catch (error) {
    console.error("Error generating subtitles:", error);
    throw error;
  }
};

export const getWordDefinition = async (word: string, contextSentence: string): Promise<WordDefinition> => {
  try {
    const prompt = `
      Define the word "${word}" based on its context in the sentence: "${contextSentence}".
      Return a JSON object with:
      - word: the base form of the word
      - phonetic: IPA phonetic transcription
      - partOfSpeech: e.g., noun, verb, adjective
      - meaning: a concise definition in English
      - usage: A brief explanation of how it is used in this context
      - example: A new example sentence using the word
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            word: { type: Type.STRING },
            phonetic: { type: Type.STRING },
            partOfSpeech: { type: Type.STRING },
            meaning: { type: Type.STRING },
            usage: { type: Type.STRING },
            example: { type: Type.STRING },
          },
          required: ["word", "phonetic", "meaning", "usage", "example"],
        },
      },
    });

    const jsonStr = response.text;
    if (!jsonStr) throw new Error("No definition generated");
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("Error getting definition:", error);
    throw error;
  }
};

export const generateSpeech = async (text: string): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("No audio generated");
    return base64Audio;

  } catch (error) {
    console.error("Error generating speech:", error);
    throw error;
  }
};

export const playAudio = async (base64String: string) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const binaryString = atob(base64String);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(0);
};