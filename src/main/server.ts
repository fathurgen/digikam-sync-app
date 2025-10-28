// src/main/server.ts
import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import mime from 'mime';
import { start } from 'repl';
import { startBonjourService, startUdpDiscoveryServer } from '../services/electron-exporter';

export type ServerHandle = {
  app: ReturnType<typeof express> | null;
  serverRef: any | null;
  port: number | null;
  photosRoot?: string;
  outFolder?: string;
};

let handle: ServerHandle = { app: null, serverRef: null, port: null };

function isInside(parent: string, child: string) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Start the local HTTP server that serves:
 *  - /albums.json -> outFolder/albums.json
 *  - /manifest.json -> outFolder/manifest.json
 *  - /thumbs/:name -> outFolder/.thumbs/:name
 *  - /image?path=<urlencoded relative path> -> photosRoot/<relative path>
 *  - /metadata/:id -> outFolder/metadata/:id.json
 *  - PUT /metadata/:id -> write metadata
 *  - POST /upload -> multipart upload into photosRoot (option ?album=rel/path)
 *  - POST /sync/changes -> receive change list
 *  - /health
 *  - /events -> server-sent events (SSE)
 *
 * Returns { host, port, url } or throws.
 */
export async function startServer(photosRoot: string, outFolder: string, preferredPort = 0) {
  if (!fs.existsSync(outFolder)) throw new Error('outFolder not found: ' + outFolder);
  if (!fs.existsSync(photosRoot)) throw new Error('photosRoot not found: ' + photosRoot);

  if (handle.serverRef) {
    // if server already running for same folders, return info
    if (handle.photosRoot === photosRoot && handle.outFolder === outFolder && handle.port) {
      return getServerInfo(handle.port);
    } else {
      // else stop then restart
      await stopServer();
    }
  }

  const app = express();
  app.use(cors()); // allow cross-origin (mobile will fetch from LAN)
  app.disable('x-powered-by');

  // small middleware to avoid path traversal & log
  app.use((req, res, next) => {
    // console.log('[local-server]', req.method, req.url);
    next();
  });

  // Simple token auth middleware (optional)
  const token = process.env.SYNC_TOKEN || null;
  if (token) {
    app.use((req: Request, res: Response, next) => {
      const t = req.header('X-Sync-Token') || req.query.token || '';
      if (String(t) !== token) return res.status(401).send('unauthorized');
      next();
    });
  }

  // serve albums.json
  app.get('/albums.json', (req: Request, res: Response) => {
    const f = path.join(outFolder, 'albums.json');
    if (!fs.existsSync(f)) return res.status(404).send('albums.json not found');
    res.type('application/json').sendFile(f);
  });

  // serve manifest.json
  app.get('/manifest.json', (req: Request, res: Response) => {
    const f = path.join(outFolder, 'manifest.json');
    if (!fs.existsSync(f)) return res.status(404).send('manifest.json not found');
    res.type('application/json').sendFile(f);
  });

  // serve thumbnails by filename
  // e.g. GET /thumbs/<sha>-800x800.jpg
  app.get('/thumbs/:name', (req: Request, res: Response) => {
    const name = req.params.name || '';
    if (!name || name.includes('..')) return res.status(400).send('invalid name');

    // build path and ensure inside outFolder/.thumbs
    const thumbsDir = path.join(outFolder, '.thumbs');
    const f = path.join(thumbsDir, name);

    // debug logs (optional, hapus setelah OK)
    console.log('[thumbs] request ->', name);
    console.log('[thumbs] resolved ->', f);
    console.log('[thumbs] thumbsDir ->', thumbsDir);
    console.log('[thumbs] exists ->', fs.existsSync(f));

    if (!fs.existsSync(f)) {
      return res.status(404).send('thumb not found');
    }
    if (!isInside(thumbsDir, f)) return res.status(400).send('invalid');

    // safer: stream file instead of sendFile
    fs.stat(f, (err, stat) => {
      if (err) {
        console.error('[thumbs] stat error', err);
        return res.status(404).send('thumb not found');
      }

      // set headers
      const mt = mime.getType(f) || 'application/octet-stream';
      res.setHeader('Content-Type', mt);
      res.setHeader('Content-Length', String(stat.size));
      // optional: cache-control for thumbs
      res.setHeader('Cache-Control', 'public, max-age=86400');

      const read = fs.createReadStream(f);
      read.on('error', (e) => {
        console.error('[thumbs] stream error', e);
        if (!res.headersSent) res.status(500).end('read error');
        else res.end();
      });
      read.pipe(res);
    });
  });

  // serve original image by relative path (urlencoded)
  // GET /image?path=<urlencoded relative path>
  app.get('/image', (req: Request, res: Response) => {
    const rel = req.query.path;
    if (!rel || typeof rel !== 'string') return res.status(400).send('path required');

    // normalize and join with photosRoot
    // Accept only relative paths (no starting slash)
    const decoded = decodeURIComponent(rel);
    if (decoded.includes('..')) return res.status(400).send('invalid path');
    const f = path.join(photosRoot, decoded);
    if (!fs.existsSync(f)) return res.status(404).send('file not found');
    if (!isInside(photosRoot, f)) return res.status(400).send('invalid path');
    res.sendFile(f);
  });

  // === metadata endpoints ===
  // GET metadata by id -> outFolder/metadata/<id>.json
  app.get('/metadata/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id || id.includes('..')) return res.status(400).send('invalid id');

    const metaDir = path.join(outFolder, 'metadata');
    const metaPath = path.join(metaDir, `${id}.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).send('metadata not found');
    if (!isInside(metaDir, metaPath)) return res.status(400).send('invalid path');
    res.type('application/json').sendFile(metaPath);
  });

  // PUT metadata -> write JSON to outFolder/metadata/<id>.json
  app.put('/metadata/:id', express.json({ limit: '2mb' }), (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id || id.includes('..')) return res.status(400).send('invalid id');

    const metaDir = path.join(outFolder, 'metadata');
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

    const metaPath = path.join(metaDir, `${id}.json`);
    if (!isInside(metaDir, metaPath)) return res.status(400).send('invalid path');

    try {
      fs.writeFileSync(metaPath, JSON.stringify(req.body, null, 2), 'utf-8');
      // optionally could trigger worker here
      return res.json({ ok: true, path: path.relative(outFolder, metaPath) });
    } catch (err: any) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // === upload endpoint ===
  // multipart upload to photosRoot or photosRoot/<album>
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        // optional album query param ?album=rel/path
        const album = typeof req.query.album === 'string' ? req.query.album : '';
        const relAlbum = album ? decodeURIComponent(String(album)) : '';
        if (relAlbum.includes('..')) return cb(new Error('invalid album'), photosRoot);

        const dest = relAlbum ? path.join(photosRoot, relAlbum) : photosRoot;
        try {
          // ensure inside photosRoot
          if (!isInside(photosRoot, dest)) return cb(new Error('invalid destination'), photosRoot);
          if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
          cb(null, dest);
        } catch (err) {
          cb(err as any, photosRoot);
        }
      },
      filename: (req, file, cb) => {
        // keep original name but avoid collisions by prefixing timestamp if file exists
        const desired = file.originalname;
        cb(null, desired);
      },
    }),
    limits: {
      fileSize: 200 * 1024 * 1024, // 200 MB limit by default, tune as needed
    },
  });

  app.post('/upload', (req: Request, res: Response, next) => {
    // accept up to 50 files in one request
    const handler = upload.array('files', 50);
    handler(req as any, res as any, (err?: any) => {
      if (err) return res.status(400).json({ error: String(err) });
      next();
    });
  }, (req: Request, res: Response) => {
    const files = (req as any).files as Express.Multer.File[] || [];
    const saved = files.map(f => ({
      originalname: f.originalname,
      path: path.relative(outFolder, f.path).replace(/\\/g, '/'), // note: if uploading into photosRoot this path may be outside outFolder
      size: f.size,
    }));
    // If you need the server to update albums.json or trigger the thumbnail worker, do it here.
    return res.json({ uploaded: saved.length, files: saved });
  });

  // === sync changes endpoint (simple echo for now) ===
  app.post('/sync/changes', express.json({ limit: '2mb' }), (req: Request, res: Response) => {
    const changes = req.body;
    // for now just log and echo back counts
    console.log('[sync/changes] received:', Array.isArray(changes) ? changes.length : typeof changes);
    return res.json({ ok: true, received: Array.isArray(changes) ? changes.length : 1 });
  });

  // === Server-Sent Events (SSE) for simple push notifications ===
  const sseClients: Response[] = [];
  app.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('retry: 10000\n\n'); // retry hint
    sseClients.push(res);

    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx >= 0) sseClients.splice(idx, 1);
    });
  });

  function broadcastEvent(eventName: string, data: any) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(c => {
      try { c.write(payload); } catch (_) { /* ignore write errors */ }
    });
  }

  // health
  app.get('/health', (_req, res) => res.send({ ok: true }));

  // choose host & start listening
  // use 0 => ephemeral port, we then return chosen port
  const listener = app.listen(preferredPort, '0.0.0.0');
  // wait for listening
  await new Promise<void>((resolve, reject) => {
    listener.on('listening', () => resolve());
    listener.on('error', (err) => reject(err));
  });

  const addr: any = listener.address();
  const port = typeof addr === 'object' ? addr.port : Number(addr);
  handle = { app, serverRef: listener, port, photosRoot, outFolder };

  // Mulai Bonjour dan UDP Discovery setelah server siap
  startBonjourService(port); // jika fungsi menerima port
  startUdpDiscoveryServer(port); // jika fungsi menerima port

  // expose broadcast via handle if needed (not exported here, but you can adapt)
  (handle as any).broadcast = broadcastEvent;

  return getServerInfo(port);
}

export async function stopServer() {
  if (!handle.serverRef) return;
  await new Promise<void>((resolve, _) => {
    handle.serverRef.close(() => {
      handle = { app: null, serverRef: null, port: null };
      resolve();
    });
  });
}

export function getServerInfo(port?: number) {
  const p = port ?? handle.port;
  if (!p) throw new Error('server not running');
  const hostIp = getLocalIp() || '127.0.0.1';
  return {
    host: hostIp,
    port: p,
    url: `http://${hostIp}:${p}`,
    albums: `${hostIp}:${p}/albums.json`,
  };
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const k of Object.keys(ifaces)) {
    const net = ifaces[k] || [];
    for (const ni of net) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
