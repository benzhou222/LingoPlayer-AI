import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Polyfill process.env to prevent crashes in libraries that expect it
    'process.env': {}
  },
  server: {
    headers: {
      // Required for FFmpeg WASM to work (SharedArrayBuffer)
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    proxy: {
      // Proxy for Local Whisper Server
      '/proxy/local-ai': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/local-ai/, ''),
        secure: false,
        // Advanced configuration
        configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
                // Remove browser identifiers
                proxyReq.removeHeader('Origin');
                proxyReq.removeHeader('Referer');
                // Keep connection alive
                proxyReq.setHeader('Connection', 'keep-alive');
                console.log(`[Proxy] Sending ${req.method} request to: ${proxyReq.host}${proxyReq.path}`);
            });
            proxy.on('error', (err, req, res) => {
                console.error('[Proxy Error]', err);
            });
            proxy.on('proxyRes', (proxyRes, req, res) => {
                console.log(`[Proxy] Received ${proxyRes.statusCode} from target`);
            });
        }
      },
      // Proxy for Local Ollama
      '/proxy/ollama': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/ollama/, ''),
        secure: false,
        configure: (proxy, options) => {
             proxy.on('proxyReq', (proxyReq) => {
                proxyReq.removeHeader('Origin');
                proxyReq.removeHeader('Referer');
             });
        }
      }
    }
  }
});