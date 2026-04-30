import { getRootPath, readJsonFromRoot } from './utils.js';
import path from "path";
import type { UserConfig } from 'vite';

const config = await readJsonFromRoot("/config.json");
const rootPath = getRootPath();

const viteConfig: UserConfig = {
    build: {
        sourcemap: false,
        minify: false,
        emptyOutDir: false,
        lib: {
            entry: './src/visual.ts',
            name: 'visual',
            // FIXME: Neither format loads correctly in PowerBI
            formats: ['iife'],
            fileName: () => 'visual.js',
        },
        rollupOptions: {
            output: {
                assetFileNames: (assetInfo) => {
                    if (assetInfo.names?.[0]?.endsWith('.css')) {
                        return config.build.css;
                    }
                    return '[name][extname]';
                },
            },
            external: [
                "assert", "buffer", "child_process", "cluster", "console", "constants",
                "crypto", "dgram", "dns", "domain", "events", "fs", "http", "https",
                "net", "os", "path", "process", "punycode", "querystring", "readline",
                "repl", "stream", "string_decoder", "sys", "timers", "tls", "tty",
                "url", "util", "vm", "zlib",
                "_stream_duplex", "_stream_passthrough", "_stream_readable",
                "_stream_transform", "_stream_writable"
            ]
        },
        cssCodeSplit: false,
        assetsInlineLimit: Infinity,
        chunkSizeWarningLimit: 1024,
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css'],
    },
    css: {
        preprocessorOptions: {
            less: {
                paths: [path.resolve(rootPath, 'node_modules')],
            },
        },
    },
    server: {
        port: 8080,
        cors: true,
        headers: {
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=0",
        },
        hmr: false,
        watch: {
            ignored: ['**/node_modules/**'],
        },
    }
};

export default viteConfig;
