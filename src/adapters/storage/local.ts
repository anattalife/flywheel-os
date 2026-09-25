import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageAdapter } from './types.js';

export class LocalStorage implements StorageAdapter {
  readonly name = 'local';
  constructor(private dir: string) {}
  private file(key: string) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('bad storage key');
    return full;
  }
  async put(key: string, body: Buffer, contentType: string) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
    await writeFile(`${f}.type`, contentType);
  }
  async get(key: string) {
    try {
      const f = this.file(key);
      return { body: await readFile(f), contentType: (await readFile(`${f}.type`, 'utf8')).trim() };
    } catch { return null; }
  }
  async delete(key: string) {
    const f = this.file(key);
    await rm(f, { force: true }); await rm(`${f}.type`, { force: true });
  }
}
