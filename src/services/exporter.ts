import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { DatabaseService } from './database';
import { Worker } from 'worker_threads';
import { MetadataService } from './metadata';

type Album = {
	id: string;
	title: string;
	parent_id: string | null;
	cover: string | null;
	images: { path: string, hash: string }[];
	updated_at: string;
};

type AlbumRaw = {
	id: string;
	albumRoot: string;
	relativePath: string | null;
	caption: string | null;
	modificationDate: string;
};

// type RunExportOpts = {
// 	dbPath: string;
// 	photosRoot: string;
// 	outFolder: string;
// };

// type ManifestFile = {
// 	path: string;
// 	size: number;
// 	mtime: number;
// 	sha1: string;
// };

// === Utility Helpers ===
function sha1FileSync(p: string): string {
	const data = fs.readFileSync(p);
	return crypto.createHash('sha1').update(data).digest('hex');
}

// Worker thread for async SHA1 calculation
function sha1FileWorker(absPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(`
            const { parentPort, workerData } = require('worker_threads');
            const fs = require('fs');
            const crypto = require('crypto');
            try {
                const data = fs.readFileSync(workerData.path);
                const hash = crypto.createHash('sha1').update(data).digest('hex');
                parentPort.postMessage(hash);
            } catch (e) {
                parentPort.postMessage('');
            }
        `, { eval: true, workerData: { path: absPath } });
		worker.on('message', resolve);
		worker.on('error', reject);
	});
}

function walkDir(root: string, cb: (full: string, st: fs.Stats) => void): void {
	for (const name of fs.readdirSync(root)) {
		const full = path.join(root, name);
		const st = fs.statSync(full);
		if (st.isDirectory()) walkDir(full, cb);
		else cb(full, st);
	}
}

function safeBasename(rel: string): string {
	if (!rel) return 'Untitled';
	return path.basename(rel) || rel;
}

let shouldAbort = false;

export function abortExport() {
  shouldAbort = true;
}

// === 1. Export Album Structure ===
export async function exportAlbums(dbPath: string, photosRoot: string, outFolder: string, progressCallback?: (msg: string, progress: number) => void) {
	shouldAbort = false;
	if (!fs.existsSync(dbPath)) throw new Error('Database not found: ' + dbPath);

	progressCallback?.('Opening database...', 10);
	const dbService = new DatabaseService(dbPath);

	progressCallback?.('Reading database structure...', 20);
	const tables = dbService.getDatabaseTables();

	const tableCols: Record<string, string[]> = {};
	for (const t of tables) tableCols[t] = dbService.getTableColumns(dbService, t);

	progressCallback?.('Processing album roots...', 30);
	const albumRootsMap: Record<number | string, string> = {};
	if (tables.includes('AlbumRoots')) {
		const rows = dbService.getTable(['id', 'label', 'specificPath'], 'AlbumRoots');
		for (const r of rows) albumRootsMap[(r as any).id] = (r as any).specificPath ?? '';
	}

	progressCallback?.('Fetching albums...', 40);
	const albumsRaw: AlbumRaw[] = dbService.getTable(['id', 'albumRoot', 'relativePath', 'caption', 'modificationDate'], 'Albums') as AlbumRaw[];

	progressCallback?.('Processing album contents...', 50);
	const metadataService = new MetadataService(path.join(outFolder, 'metadata.db'));
	const total = albumsRaw.length;

	// Ambil metadata hash semua file hanya sekali di awal
	const existingMeta = new Map(
		metadataService.getAllFiles().map((f: any) => [f.path, f.hash])
	);

	for (let i = 0; i < albumsRaw.length; i++) {
		if (shouldAbort) {
			progressCallback?.('Export aborted by user.', 0);
			return false;
		}
		const albumRaw: AlbumRaw = albumsRaw[i];
		const progress = 50 + Math.floor((i / total) * 40); // Progress from 50% to 90%
		progressCallback?.(`Processing album ${i + 1} of ${total}: ${albumRaw.caption || safeBasename(albumRaw.relativePath)}`, progress);

		const rootPath = albumRootsMap[albumRaw.albumRoot] || photosRoot;
		const albumAbs = path.join(rootPath, albumRaw.relativePath ?? '');
		// Log hanya saat mulai album
		console.log(`Processing album: ${albumRaw.id} | ${albumRaw.caption || safeBasename(albumRaw.relativePath)} | rootPath: ${rootPath}, albumAbs: ${albumAbs}`);

		if (fs.existsSync(albumAbs) && fs.statSync(albumAbs).isDirectory()) {
			const files: string[] = [];
			const walk = (dir: string) => {
				for (const name of fs.readdirSync(dir)) {
					const full = path.join(dir, name);
					const st = fs.statSync(full);
					if (st.isDirectory()) walk(full);
					else files.push(path.relative(photosRoot, full).split(path.sep).join('/'));
				}
			};
			walk(albumAbs);

			for (let j = 0; j < files.length; j++) {
				if (shouldAbort) {
					progressCallback?.('Export aborted by user.', 0);
					return false;
				}
				const relPath = files[j];
				const absPath = path.join(photosRoot, relPath);
				// Resume: skip if hash already exists and is valid
				if (existingMeta.has(relPath) && existingMeta.get(relPath)) continue;

				let hash = '';
				try {
					hash = fs.existsSync(absPath) ? await sha1FileWorker(absPath) : '';
				} catch (e) {
					hash = '';
				}
				// Tambahkan metadata:
				const st = fs.statSync(absPath);
				metadataService.upsertFile({
					path: relPath,
					size: st.size,
					mtime: Math.floor(st.mtimeMs / 1000),
					hash
				});
				existingMeta.set(relPath, hash); // update cache agar resume tetap efisien

				// Progress per file agar UI lebih informatif
				const albumName = path.dirname(relPath).split(path.sep).join('/');
				if (j % 10 === 0 || j === files.length - 1) {
					const fileProgress = progress + Math.floor((j / files.length) * (40 / total));
					progressCallback?.(`Processing: ${j + 1}/${files.length} | Album:${albumName} | File: ${relPath}`, fileProgress);
					await new Promise(res => setTimeout(res, 0));
				}
			}
		}
		// Allow event loop to process logs/UI
		await new Promise(res => setTimeout(res, 0));
	}

	progressCallback?.('Manifest database updated', 100);
	return true;
}

// === 2. Manifest Generation ===
// (Nonaktifkan penulisan manifest.json, gunakan metadata.db saja)
export async function generateManifest(photosRoot: string, outFolder: string, progressCallback?: (msg: string, progress: number) => void) {
    progressCallback?.('Starting manifest generation...', 0);
    const metadataService = new MetadataService(path.join(outFolder, 'metadata.db'));
    // Ambil metadata semua file di awal
    const existingMeta = new Map(
        metadataService.getAllFiles().map((f: any) => [f.path, { size: f.size, mtime: f.mtime, hash: f.hash }])
    );
    let fileCount = 0;
    progressCallback?.('Counting files...', 10);
    let totalFiles = 0;
    walkDir(photosRoot, () => totalFiles++);
    progressCallback?.('Processing files...', 20);
    let processed = 0;
    await (async () => {
        walkDir(photosRoot, async (full, st) => {
            const rel = path.relative(photosRoot, full).split(path.sep).join('/');
            if (rel.startsWith('.thumbs/')) return;
            fileCount++;
            const meta = existingMeta.get(rel);
            const size = st.size;
            const mtime = Math.floor(st.mtimeMs / 1000);
            // Jika metadata sudah ada dan size/mtime sama, skip hash dan upsert
            if (meta && meta.size === size && meta.mtime === mtime && meta.hash) {
                // skip
            } else {
                // File baru/berubah, hitung hash dan upsert
                const hash = sha1FileSync(full);
                metadataService.upsertFile({
                    path: rel,
                    size,
                    mtime,
                    hash
                });
                existingMeta.set(rel, { size, mtime, hash });
            }
            processed++;
            if (processed % 100 === 0 || processed === totalFiles) {
                const progress = 20 + Math.floor((processed / totalFiles) * 70);
                progressCallback?.(`Processing file ${processed} of ${totalFiles}...`, progress);
                await new Promise(res => setTimeout(res, 0));
            }
        });
    })();
    progressCallback?.('Manifest database updated', 100);
    return true;
}

// === 3. Thumbnail Generator (simplified) ===
export async function ensureThumbnail(photosRoot: string, outFolder: string, relPath: string, w = 512, h = 512) {
	const safe = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
	const full = path.join(photosRoot, safe);
	if (!fs.existsSync(full)) throw new Error('File not found: ' + full);

	const thumbDir = path.join(outFolder, '.thumbs');
	fs.mkdirSync(thumbDir, { recursive: true });

	const nameHash = crypto.createHash('sha1').update(relPath).digest('hex');
	const thumbPath = path.join(thumbDir, `${nameHash}-${w}x${h}.jpg`);

	if (fs.existsSync(thumbPath)) return thumbPath;

	try {
		await sharp(full)
			.rotate()
			.resize(w, h, { fit: 'inside' })
			.jpeg({ quality: 82 })
			.toFile(thumbPath);
		return thumbPath;
	} catch (e) {
		console.warn('Thumbnail failed for:', relPath, e);
		throw e;
	}
}

// === 4. Batch Thumbnail Generation ===
export async function preGenerateThumbnails(photosRoot: string, outFolder: string, paths: string[], concurrency = 4) {
	let index = 0;
	const total = paths.length;
	const results: { path: string; ok: boolean; error?: string }[] = [];

	async function worker() {
		while (index < total) {
			const i = index++;
			const rel = paths[i];
			try {
				await ensureThumbnail(photosRoot, outFolder, rel);
				results.push({ path: rel, ok: true });
				console.log(`✅ [${i + 1}/${total}] ${rel}`);
			} catch (e: any) {
				results.push({ path: rel, ok: false, error: String(e.message || e) });
				console.warn(`⚠️  [${i + 1}/${total}] ${rel} failed`);
			}
		}
	}

	await Promise.all(new Array(concurrency).fill(0).map(() => worker()));
	return results;
}

// bonjour and udp server -------------
const PORT: number = process.env.PORT ? Number(process.env.PORT) : 3000;
const TOKEN: string = process.env.DIGIKAM_SYNC_TOKEN ?? crypto.randomBytes(8).toString('hex');
const UDP_PORT: number = process.env.UDP_PORT ? Number(process.env.UDP_PORT) : 41234;

export function startBonjourService(port: number) {
	const bonjour = require('bonjour')();
	bonjour.publish({
		name: 'DigiKamSync',
		type: 'http',
		port: port,
		txt: { token: TOKEN, path: '/api', name: 'DigiKamSync' }
	});
	console.log("bonjour listening on port " + port + " with token " + TOKEN);
}

export function startUdpDiscoveryServer(port: number) {
	const dgram = require('dgram');
	const udpServer = dgram.createSocket('udp4');
	udpServer.on('message', (msg: any, rinfo: any) => {
		// Cek pesan handshake, balas dengan info JSON
		const response = JSON.stringify({
			name: 'DigiKamSync',
			ip: rinfo.address,
			port: port,
			url: `http://${rinfo.address}:${port}`,
			token: TOKEN
		});
		udpServer.send(response, rinfo.port, rinfo.address);
	});
	console.log("udpServer listening on port " + port + " with token " + TOKEN);
	udpServer.bind(port);
}

export default {
	exportAlbums,
	generateManifest,
	ensureThumbnail,
	preGenerateThumbnails,
	startBonjourService,
	startUdpDiscoveryServer
};
