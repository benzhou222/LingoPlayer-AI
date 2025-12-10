import { fetchFile } from '@ffmpeg/util';

// We manage FFmpeg instance globally to avoid reloading
let ffmpeg: any = null;

/**
 * Manually loads FFmpeg library and its dependencies from a CDN,
 * patching import paths to point to Blob URLs.
 * This works around CORS and strict "Worker Origin" policies in browsers.
 */
async function importFFmpeg() {
    if (ffmpeg) return ffmpeg;

    const baseURL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';
    
    // Helper to fetch text content
    const fetchText = async (url: string) => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch ${url}`);
        return await resp.text();
    };

    // Helper to create a Blob URL for a module
    const createBlobURL = (content: string, type = 'text/javascript') => {
        const blob = new Blob([content], { type });
        return URL.createObjectURL(blob);
    };

    console.log("Loading FFmpeg modules...");

    // 1. Load errors.js (Dependency of utils)
    // 2. Load utils.js (Dependency of worker & classes)
    // 3. Load const.js (Dependency of worker & classes)
    // 4. Load worker.js (Dependency of classes)
    // 5. Load classes.js (Dependency of index)
    // 6. Load index.js (Entry point)

    try {
        // --- 1. errors.js ---
        const errorsCode = await fetchText(`${baseURL}/errors.js`);
        const errorsBlobUrl = createBlobURL(errorsCode);

        // --- 2. utils.js ---
        let utilsCode = await fetchText(`${baseURL}/utils.js`);
        // Patch utils to import errors from blob
        utilsCode = utilsCode.replace(
            /from\s+['"]\.\/errors\.js['"]/g, 
            `from '${errorsBlobUrl}'`
        );
        const utilsBlobUrl = createBlobURL(utilsCode);

        // --- 3. const.js ---
        const constCode = await fetchText(`${baseURL}/const.js`);
        const constBlobUrl = createBlobURL(constCode);

        // --- 4. worker.js ---
        let workerCode = await fetchText(`${baseURL}/worker.js`);
        // Patch worker to import dependencies from blobs
        workerCode = workerCode.replace(
            /from\s+['"]\.\/utils\.js['"]/g, 
            `from '${utilsBlobUrl}'`
        ).replace(
             /from\s+['"]\.\/const\.js['"]/g, 
            `from '${constBlobUrl}'`
        );
        const workerBlobUrl = createBlobURL(workerCode);

        // --- 5. classes.js ---
        let classesCode = await fetchText(`${baseURL}/classes.js`);
        // Patch classes to import dependencies from blobs & external util
        classesCode = classesCode.replace(
            /from\s+['"]\.\/const\.js['"]/g, 
            `from '${constBlobUrl}'`
        ).replace(
            /from\s+['"]\.\/utils\.js['"]/g, 
            `from '${utilsBlobUrl}'`
        ).replace(
            /from\s+['"]\.\/worker\.js['"]/g, 
            `from '${workerBlobUrl}'`
        ).replace(
            /from\s+['"]\.\/errors\.js['"]/g, 
            `from '${errorsBlobUrl}'`
        );
        
        // IMPORTANT: Patch the Worker creation to use the full CDN URL for the actual worker script
        // The library tries to load "worker.js" relative to itself.
        // We need to force it to use a Blob URL or the full CDN path if CORS allows.
        // For 0.12.x, we usually pass coreURL and wasmURL to load(), but the worker wrapper itself 
        // is created inside classes.js.
        // The best way for the worker wrapper is to let it be, but ensuring it doesn't cross-origin fail.
        
        // Actually, best practice for 0.12.x in strict env is to rely on the class structure 
        // but ensuring the imports inside classes.js resolve. 
        const classesBlobUrl = createBlobURL(classesCode);

        // --- 6. index.js ---
        let indexCode = await fetchText(`${baseURL}/index.js`);
        indexCode = indexCode.replace(
            /from\s+['"]\.\/classes\.js['"]/g, 
            `from '${classesBlobUrl}'`
        ).replace(
            /from\s+['"]\.\/utils\.js['"]/g, 
            `from '${utilsBlobUrl}'`
        );
        const indexBlobUrl = createBlobURL(indexCode);

        // --- Dynamic Import ---
        const module = await import(indexBlobUrl);
        const { FFmpeg } = module;
        
        ffmpeg = new FFmpeg();
        
        // Logging
        ffmpeg.on('log', ({ message }: { message: string }) => {
            console.log('[FFmpeg Log]:', message);
        });

        return ffmpeg;

    } catch (e) {
        console.error("FFmpeg Manual Load Failed:", e);
        throw e;
    }
}

async function loadFFmpeg(onProgress?: (progress: number) => void) {
    const ffmpegInstance = await importFFmpeg();
    
    if (!ffmpegInstance.loaded) {
        if (onProgress) onProgress(1); // Fake start
        
        // Determine thread support
        const isMultiThreaded = window.crossOriginIsolated;
        const coreBase = isMultiThreaded 
            ? 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm'
            : 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
        
        console.log(`Loading FFmpeg Core (${isMultiThreaded ? 'Multi-threaded' : 'Single-threaded'})...`);
        if (onProgress) onProgress(5);

        await ffmpegInstance.load({
            coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
            workerURL: isMultiThreaded 
                ? await toBlobURL(`${coreBase}/ffmpeg-core.worker.js`, 'text/javascript')
                : undefined,
        });
        
        if (onProgress) onProgress(10);
        console.log("FFmpeg Core Loaded.");
    }
    return ffmpegInstance;
}

// Helper to download binary as Blob URL
async function toBlobURL(url: string, mimeType: string) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return URL.createObjectURL(new Blob([blob], { type: mimeType }));
}

/**
 * Extracts audio from a video file and converts it to a standard 16kHz Mono WAV.
 * Used as fallback when browser cannot decode the video's audio natively (e.g. MKV/AC3).
 */
export async function extractAudioAsWav(videoFile: File): Promise<Float32Array> {
    try {
        const instance = await loadFFmpeg();
        
        const inputName = 'input.video'; // Generic name to avoid filesystem issues
        const outputName = 'output.wav';
        
        await instance.writeFile(inputName, await fetchFile(videoFile));
        
        // Convert to 16kHz mono pcm_f32le (which is what AudioContext buffers usually are, or closest to it)
        // actually we output a WAV and then decode it with AudioContext again to get Float32Array easily
        // Or we can output raw float32. Let's output WAV for compatibility.
        // -ar 16000: 16kHz
        // -ac 1: Mono
        // -map 0:a:0 : Select first audio track
        
        // Check threads
        const threads = window.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;
        const cmd = ['-i', inputName, '-ar', '16000', '-ac', '1', '-map', '0:a:0', outputName];
        if (threads > 1) cmd.unshift('-threads', threads.toString());

        console.log("Running FFmpeg extraction:", cmd.join(' '));
        const ret = await instance.exec(cmd);
        
        if (ret !== 0) {
            throw new Error(`FFmpeg exited with code ${ret}`);
        }
        
        const data = await instance.readFile(outputName);
        
        // Clean up
        await instance.deleteFile(inputName);
        await instance.deleteFile(outputName);
        
        // Decode the WAV file to Float32Array using browser API
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        const audioBuffer = await audioCtx.decodeAudioData(data.buffer);
        return audioBuffer.getChannelData(0);

    } catch (e) {
        console.error("FFmpeg Audio Extraction Failed:", e);
        throw e;
    }
}
