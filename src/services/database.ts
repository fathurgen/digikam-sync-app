import Database from "better-sqlite3";


export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
  }

  getDatabaseTables() {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  }

  getTableColumns(db: any, table: string): string[] {
    try {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all();
      return rows.map((r: any) => r.name);
    } catch {
      return [];
    }
  }

  getTable(selectedColumns: string[], tableName: string) {
    return this.db.prepare(`SELECT ${selectedColumns.join(', ')} FROM ${tableName}`).all();
  }

}