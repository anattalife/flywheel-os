import { config } from '../../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { StorageAdapter } from './types.js';

let adapter: StorageAdapter | undefined;
export function storage(): StorageAdapter {
  if (!adapter) {
    const c = config();
    if (c.STORAGE_PROVIDER === 's3') {
      if (!c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
      adapter = new S3Storage({ bucket: c.S3_BUCKET, region: c.S3_REGION, accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY, endpoint: c.S3_ENDPOINT });
    } else adapter = new LocalStorage(c.STORAGE_DIR);
  }
  return adapter;
}
export function setStorageAdapter(a: StorageAdapter) { adapter = a; }
