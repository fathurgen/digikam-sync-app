export class StorageService {
  setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
  }

  setObject<T>(key: string, value: T): void {
    localStorage.setItem(key, JSON.stringify(value));
  }

  getItem(key: string): string | null {
    return localStorage.getItem(key);
  } 

  getObject<T>(key: string): T | null {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : null;
  }
}