// Copies non-TypeScript files the server needs at runtime into dist/.
import { cp } from 'node:fs/promises';
await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });
await cp('src/web', 'dist/web', { recursive: true });
console.log('assets copied');
