import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { onRequest } from 'firebase-functions/v2/https';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

const expressServer = express();
const jsonParser = express.json({ limit: '8mb' });

// Cloud Functions v2 pre-reads the HTTP stream and populates req.rawBody / req.body
// before delegating to the Express handler, so re-reading the raw stream would hang/fail.
expressServer.use((req: Request, res: Response, next: NextFunction) => {
  const contentType = req.headers['content-type'] ?? '';
  const gcfReq = req as Request & { rawBody?: Buffer };
  if (req.body !== undefined) {
    next();
    return;
  }
  if (gcfReq.rawBody && contentType.includes('application/json')) {
    try {
      const raw = gcfReq.rawBody.toString('utf8').trim();
      req.body = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ statusCode: 400, message: 'INVALID_JSON' });
      return;
    }
    next();
    return;
  }
  if (gcfReq.rawBody) {
    next();
    return;
  }
  jsonParser(req, res, next);
});

let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const app = await NestFactory.create<NestExpressApplication>(
        AppModule,
        new ExpressAdapter(expressServer),
        { bodyParser: false },
      );
      configureApp(app, { skipBodyParser: true });
      await app.init();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export const mnisApi = onRequest(
  {
    region: 'europe-west1',
    memory: '1GiB',
    timeoutSeconds: 60,
    maxInstances: 10,
    invoker: 'public',
  },
  async (req, res) => {
    await ensureInitialized();
    expressServer(req, res);
  },
);
