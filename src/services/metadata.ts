import Database from "better-sqlite3";


export class MetadataService {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        size INTEGER,
        mtime INTEGER,
        hash TEXT
      );
    `);
  }

  upsertFile(meta: { path: string, size: number, mtime: number, hash: string }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO files (path, size, mtime, hash) VALUES (?, ?, ?, ?)`
    ).run(meta.path, meta.size, meta.mtime, meta.hash);
  }

  getAllFiles() {
    return this.db.prepare(`SELECT * FROM files`).all();
  }

  getChangedFiles(since: number) {
    return this.db.prepare(`SELECT * FROM files WHERE mtime > ?`).all(since);
  }

}