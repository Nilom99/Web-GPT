import express from 'express';
import path from 'node:path';
import { Readable } from 'node:stream';
import { handleApiRequest } from './backend/router';
import { triggerBackgroundWarmup } from './backend/model/loader';

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', true);

  // Bridge Express /api/* requests to the shared Web Request/Response router
  app.use('/api', async (req, res) => {
    try {
      const protocol = req.protocol || 'http';
      const host = req.get('host') || `localhost:${port}`;
      const fullUrl = `${protocol}://${host}${req.originalUrl}`;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else if (typeof value === 'string') {
          headers.set(key, value);
        }
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          abortController.abort();
        }
      });

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
      let bodyInit: BodyInit | undefined;
      if (hasBody) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        bodyInit = Buffer.concat(chunks);
      }

      const webRequest = new Request(fullUrl, {
        method: req.method,
        headers,
        body: bodyInit,
        signal: abortController.signal,
      });

      const webResponse = await handleApiRequest(webRequest);
      res.status(webResponse.status);
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!webResponse.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(
        webResponse.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
      );
      nodeStream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      nodeStream.pipe(res);
    } catch (err) {
      console.error('[server] API bridge error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error.' });
      }
    }
  });

  if (isProd) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`WebGPT server listening on http://localhost:${port}`);
    // Begin lazy background model & runtime readiness verification
    triggerBackgroundWarmup();
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
