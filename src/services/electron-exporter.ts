import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';

type Album = {
	id: string;
	title: string;
	parent_id: string | null;
	cover: string | null;
	images: string[];
	updated_at: string;
};

type RunExportOpts = {
	dbPath: string;
	photosRoot: string;
	outFolder: string;
};

type ManifestFile = {
	path: string;
	size: number;
	mtime: number;
	sha1: string;
};

// === Utility Helpers ===
function sha1FileSync(p: string): string {
	const data = fs.readFileSync(p);
	return crypto.createHash('sha1').update(data).digest('hex');
}

function walkDir(root: string, cb: (full: string, st: fs.Stats) => void): void {
	for (const name of fs.readdirSync(root)) {
		const full = path.join(root, name);
		const st = fs.statSync(full);
		if (st.isDirectory()) walkDir(full, cb);
		else cb(full, st);
	}
}

function getTableColumns(db: any, table: string): string[] {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all();
		return rows.map((r: any) => r.name);
	} catch {
		return [];
	}
}

function safeBasename(rel: string): string {
	if (!rel) return 'Untitled';
	return path.basename(rel) || rel;
}

// === 1. Export Album Structure ===
export function exportAlbums(dbPath: string, photosRoot: string, outFolder: string, progressCallback?: (msg: string, progress: number) => void) {
    if (!fs.existsSync(dbPath)) throw new Error('Database not found: ' + dbPath);
    
    progressCallback?.('Opening database...', 10);
    const db = new Database(dbPath, { readonly: true });

    progressCallback?.('Reading database structure...', 20);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    const tableCols: Record<string, string[]> = {};
    for (const t of tables) tableCols[t] = getTableColumns(db, t);

    progressCallback?.('Processing album roots...', 30);
    const albumRootsMap: Record<number | string, string> = {};
    if (tables.includes('AlbumRoots')) {
        const rows = db.prepare(`SELECT id, label, specificPath FROM AlbumRoots`).all();
        for (const r of rows) albumRootsMap[(r as any).id] = (r as any).specificPath ?? '';
    }

    progressCallback?.('Fetching albums...', 40);
    const albumsRaw = db.prepare('SELECT id, albumRoot, relativePath, caption, modificationDate FROM Albums').all();

    progressCallback?.('Processing album contents...', 50);
    const albums: Album[] = [];
    const total = albumsRaw.length;
    
    for (let i = 0; i < albumsRaw.length; i++) {
        const a = albumsRaw[i];
        const progress = 50 + Math.floor((i / total) * 40); // Progress from 50% to 90%
        progressCallback?.(`Processing album ${i + 1} of ${total}...`, progress);
        
        const rootPath = albumRootsMap[(a as any).albumRoot] || photosRoot;
		const albumAbs = path.join(rootPath, (a as any).relativePath ?? '');
		const title = (a as any).caption || safeBasename((a as any).relativePath);

		let images: string[] = [];

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
			images = files;
		}

		albums.push({
			id: String((a as any).id),
			title,
			parent_id: null,
			cover: images[0] || null,
			images,
			updated_at: (a as any).modificationDate ?? new Date().toISOString()
		});
    }

    progressCallback?.('Saving album data...', 95);
    const output = { generated_at: new Date().toISOString(), albums };
    fs.mkdirSync(outFolder, { recursive: true });
    fs.writeFileSync(path.join(outFolder, 'albums.json'), JSON.stringify(output, null, 2), 'utf8');

    progressCallback?.('Album export complete', 100);
    return output;
}

// === 2. Manifest Generation ===
export function generateManifest(photosRoot: string, outFolder: string, progressCallback?: (msg: string, progress: number) => void) {
    progressCallback?.('Starting manifest generation...', 0);
    
    const files: ManifestFile[] = [];
    let fileCount = 0;
    
    // First count total files for progress calculation
    progressCallback?.('Counting files...', 10);
    let totalFiles = 0;
    walkDir(photosRoot, () => totalFiles++);
    
    progressCallback?.('Processing files...', 20);
    walkDir(photosRoot, (full, st) => {
        const rel = path.relative(photosRoot, full).split(path.sep).join('/');
        if (rel.startsWith('.thumbs/')) return;
        
        fileCount++;
        const progress = 20 + Math.floor((fileCount / totalFiles) * 70); // Progress from 20% to 90%
        progressCallback?.(`Processing file ${fileCount} of ${totalFiles}...`, progress);
        
        files.push({
            path: rel,
            size: st.size,
            mtime: Math.floor(st.mtimeMs / 1000),
            sha1: sha1FileSync(full)
        });
    });

    progressCallback?.('Saving manifest...', 95);
    const manifest = { generated_at: new Date().toISOString(), files };
    fs.writeFileSync(path.join(outFolder, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    
    progressCallback?.('Manifest generation complete', 100);
    console.log('Manifest generated:', path.join(outFolder, 'manifest.json'));
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

export default {
	exportAlbums,
	generateManifest,
	ensureThumbnail,
	preGenerateThumbnails
};
