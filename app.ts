import dns from 'node:dns';
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}
import {installHttpSecurity} from './integration/http-security';

import dotenv from 'dotenv';
import express from 'express';
import { mountEngram } from './integration/engram';

dotenv.config();

/** The API app, shared by the local server (server.ts) and the Vercel function (vercel/handler.ts). */
export async function createApp({serverless=false}:{serverless?:boolean}={}) {
  const app = express();
  // Behind Vercel's proxy: client IPs for rate limits, https for the same-origin check.
  if (serverless) app.set('trust proxy', true);

  installHttpSecurity(app);
  app.use(express.json({ limit: '2mb' }));
  app.use((error:any,_req:express.Request,res:express.Response,next:express.NextFunction)=>{
    if(error?.type==='entity.too.large')return void res.status(413).json({error:'Request too large'});
    if(error instanceof SyntaxError)return void res.status(400).json({error:'Invalid JSON request'});
    next(error);
  });
  const engram = await mountEngram(app, {serverless});

  app.post('/api/gemini/reason', (_req, res) => {
    res.status(410).json({ error: 'Legacy client-context reasoning is disabled. Use the authenticated /api/engram/ask route.' });
  });
  return { app, engram };
}
