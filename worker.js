import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Skip local model checks since we are running in a browser environment
env.allowLocalModels = false;
env.useBrowserCache = true;

class PipelineFactory {
    static task = 'automatic-speech-recognition';
    static model = 'Xenova/whisper-tiny';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            this.instance = await pipeline(this.task, this.model, {
                progress_callback
            });
        }
        return this.instance;
    }
}

self.onmessage = async (event) => {
    const message = event.data;

    if (message.type === 'load') {
        try {
            await PipelineFactory.getInstance((data) => {
                self.postMessage({ type: 'progress', data });
            });
            self.postMessage({ type: 'ready' });
        } catch (error) {
            self.postMessage({ type: 'error', data: error.message });
        }
        return;
    }

    if (message.type === 'generate') {
        const { audio } = message.data;
        
        try {
            const transcriber = await PipelineFactory.getInstance();
            
            // Run the model
            // chunk_length_s: 30 allows processing long audio by splitting it
            // return_timestamps: true gives us start/end times
            const output = await transcriber(audio, {
                chunk_length_s: 30,
                stride_length_s: 5,
                language: 'english',
                return_timestamps: true,
                callback_function: (beams) => {
                    // This callback is called during generation, but formatted chunks come at the end mostly
                    // We can try to send partial updates if needed, but for stability we wait for chunks
                }
            });

            self.postMessage({ type: 'complete', data: output });

        } catch (error) {
            self.postMessage({ type: 'error', data: error.message });
        }
    }
};