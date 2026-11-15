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

### Automated Tests

```bash
npm test
npm run lint
npm run build
```

---

## Netlify Deployment Configuration

Configured in `netlify.toml` for project `verdant-kangaroo-6053a5`:
- Publish directory: `dist`
- Functions directory: `netlify/functions`
- API routing: `/api/*` -> `/.netlify/functions/api/:splat`

---

## Deployment-Size Report

Measured against the compiled production build (`npm run build`), `esbuild`-bundled Netlify Function (`netlify/functions/api.mts`), minimal `llama.cpp` CPU runtime (`runtime/llama/`), and the verified GGUF weights:

| Component | Uncompressed Size | Notes |
| --- | --- | --- |
| Frontend (`dist/`) | 939,079 B (0.94 MB / 0.90 MiB) | Vite React + Tailwind CSS production assets |
| Bundled Function + Backend (`api.mjs`) | 28,609 B (0.03 MB / 0.03 MiB) | Bundled via `esbuild` (`--platform=node --target=node22`) |
| Native Runtime (`runtime/llama/`) | 17,013,464 B (17.01 MB / 16.23 MiB) | `llama-completion` + `libllama` + `libggml` CPU libs |
| Model Weights (`Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf`) | 73,895,104 B (73.90 MB / 70.47 MiB) | Verified SHA-256 `f8f5c2f964511caf59abfa02b6b8a6867b9c429ef3366b5a3ac9d5eea79aa0f6` |
| **Total Deployable Project Footprint** | **91,876,256 B (91.88 MB / 87.62 MiB)** | **Passes `< 150 MB` ideal & `< 200 MB` absolute limit** |

### Netlify Function Bundle Measurement & Platform Constraint

- **Function ZIP including GGUF model:** **76,508,853 B (76.51 MB / 72.96 MiB)**
  - **Technical Blocker:** Quantized Q4_K_M weights do not compress well under ZIP deflate (70.67 MB zipped alone). Because Netlify Serverless Functions deploy onto AWS Lambda, they enforce a **50 MB (52,428,800 B) zipped deployment archive limit** per function. Bundling the 73.90 MB GGUF directly inside the function ZIP exceeds this 50 MB Lambda upload cap.
- **Function ZIP with runtime + backend only (smallest compatible Netlify solution):** **5,839,160 B (5.84 MB / 5.57 MiB)**
  - **How it works:** Keep `runtime/llama/**` + `api.mjs` inside the Netlify Function ZIP (**5.84 MB**, well under 50 MB), host the GGUF asset in Netlify static CDN (`public/models/` -> `dist/models/`), and allow `backend/model/loader.ts` to cold-start hydrate and SHA-256-verify the GGUF into `/tmp/webgpt/models/`. Total project footprint remains **91.88 MB** (`< 200 MB`), while the Netlify Function ZIP stays at **5.84 MB** (`< 50 MB`).
- **Additional Netlify note:** Netlify synchronous Serverless Functions have a 10s–26s execution timeout; `POST /api/chat/stream` uses Netlify Functions v2 Web Streams (`Response` with `ReadableStream`), and `Falcon-H1-Tiny-Multilingual-100M-Instruct` generates at ~108 tok/s on 4 CPU cores (~250–800 ms per response).
