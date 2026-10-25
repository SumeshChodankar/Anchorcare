import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApp } from './app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const { app, engram } = await createApp();
  const PORT = Number(process.env.PORT || 3000);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`AnchorCare server listening on http://localhost:${PORT}`);
  });
  const stop = () => server.close(() => { void engram.close().finally(() => process.exit(0)); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

startServer();
