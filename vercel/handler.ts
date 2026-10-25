import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../app';

// One app per instance, built on the first request and reused while the instance is warm.
const ready = createApp({ serverless: true });

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { app } = await ready;
  app(req as any, res as any);
}
