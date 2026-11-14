import 'reflect-metadata';
import { startWorker } from './worker.bootstrap.js';

// The queue worker as its own process (optional, production): `node dist/worker-main.js`.
await startWorker();
