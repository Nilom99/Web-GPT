# WebGPT

**Created by Abdus Nilom**

WebGPT is a full-stack AI chat web application powered by local GGUF inference (`llama.cpp` b12413) running the `Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf` hybrid Transformer + Mamba model.

---

## Tech Stack

- **Frontend:** Vite, React 19, TypeScript, Tailwind CSS v4, Lucide Icons, `marked` + `highlight.js` + `DOMPurify`, IndexedDB persistence
- **Backend:** TypeScript Web-Standard Router (`backend/router.ts`), Netlify Functions v2 (`netlify/functions/api.mts`), Express dev/production bridge (`server.ts`)
- **Inference Runtime:** Official `llama.cpp` (`b12413`) CPU Linux x64 `llama-completion` binary + shared libraries (`runtime/llama/`)
- **Model:** `Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf` (73,895,104 bytes, SHA-256 `f8f5c2f964511caf59abfa02b6b8a6867b9c429ef3366b5a3ac9d5eea79aa0f6`)

---

## Features

- Responsive desktop sidebar and mobile slide-over drawer
- Light and dark themes with persisted preference
- Real-time SSE token streaming (`POST /api/chat/stream`)
- Stop generation (`POST /api/chat/stop` + `AbortController`)
- Non-streaming completion (`POST /api/chat`)
- Edit user messages & re-submit, regenerate assistant responses, copy messages & code blocks
- Safe sanitized Markdown rendering (`DOMPurify` allowlist) and syntax highlighting
- Persistent conversation history stored locally in IndexedDB
- Export conversations as `.txt` and `.json`
- Concurrency protection, sliding-window rate limiting, generation timeout, strict CORS, and safe error handling

---

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Service health and active request count |
| `GET` | `/api/model/status` | Assistant readiness (`Loading...` / `Ready` / `Unavailable`) |
| `POST` | `/api/chat` | Single-response chat completion |
| `POST` | `/api/chat/stream` | Server-Sent Events (SSE) streaming completion |
| `POST` | `/api/chat/stop` | Cancel an active generation by `requestId` |

---

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The Express dev server (`server.ts`) proxies `/api/*` to the same
`backend/router.ts` that the Netlify Function uses, so behaviour is identical
in development and in production. The model is fetched on demand and verified
against the pinned SHA-256 checksum; `npm run build` and `npm test` prepare a
verified copy in `.cache/webgpt/models/` first.

### Automated Tests

```bash
npm test
npm run lint
npm run build
```

---

## Netlify Deployment Configuration

Configured in `netlify.toml` for project `nilgpt` (`https://nilgpt.netlify.app`):

| Setting | Value |
| --- | --- |
| Build command | `npm run build` (Vite production build + verified model asset) |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |
| Node runtime | `24` (`NODE_VERSION` in `[build.environment]`) |
| Function bundler | `esbuild` |
| Bundled function files | `runtime/llama/**` (runtime + shared libraries only) |
| API routing | `/api/*` -> `/.netlify/functions/api/:splat` |
| SPA fallback | `/*` -> `/index.html` |
| Static caching | `/models/*` and `/assets/*` -> `max-age=31536000, immutable` |

### How the model reaches the function

The 73.9 MB GGUF file is **never** part of the function bundle. It is published as a
static asset (`dist/models/...`, served from the Netlify CDN) and the function
downloads it into `/tmp/webgpt/models/` on the first request that needs it. The
download is streamed to a `.part` file, verified against the pinned SHA-256
checksum and byte size, and only then renamed into place. A failed or corrupt
download is deleted and retried, and partial files are cleaned up. The verified
copy is reused for the lifetime of the execution environment.

---

## Deployment-Size Report

Measured against the production build and the `esbuild`-bundled Netlify Function:

| Component | Size | Notes |
| --- | --- | --- |
| Frontend (`dist/`, excluding the model) | 769,308 B (0.77 MB) | Vite React + Tailwind CSS production assets |
| Model asset (`dist/models/*.gguf`) | 73,895,104 B (73.90 MB) | Static CDN asset, verified SHA-256 `f8f5c2f9...aa0f6` |
| `llama.cpp` runtime (`runtime/llama/`) | 19,572,536 B (19.57 MB) | `llama-completion` + `libllama`/`libggml` CPU libs + `libstdc++`/`libgomp` |
| Function ZIP (runtime + backend, no model) | 7,897,427 B zipped / 20,742,142 B raw | Well below the 50 MB Lambda upload cap |
| **Total deploy footprint** | **~94 MB** | Split between the static deploy and the function bundle |

### Platform constraints that shaped the implementation

- **Netlify Function ZIP limit:** the function bundle contains only the runtime
  and the backend (7.9 MB zipped). The model is served as a static asset.
- **Synchronous execution limit (60 s):** every request works against an
  explicit deadline (52 s budget, 40 s generation timeout) and aborts the
  downstream work (including the model download) before the platform kills the
  function, so the client always receives a response.
- **Ephemeral filesystem:** `/tmp` is treated as per-execution-environment
  scratch space. Nothing is assumed to survive between invocations; the model
  is re-downloaded and re-verified when the cache is empty.
- **glibc compatibility:** the bundled `llama.cpp` libraries and the bundled
  `libstdc++.so.6` / `libgomp.so.1` require at most `GLIBC_2.34` /
  `GLIBCXX_3.4.30`, which matches the Amazon Linux 2023 (glibc 2.34) image that
  Netlify Functions run on. Binaries downloaded from the upstream
  `llama.cpp` Ubuntu releases require glibc 2.35+ and therefore cannot be used
  as a fallback runtime.
- **Cross-request cancellation:** `/api/chat/stop` can only stop a generation
  that runs in the same execution environment. The reliable cancellation path
  is the client aborting the SSE connection, which is detected and terminates
  the inference process.
