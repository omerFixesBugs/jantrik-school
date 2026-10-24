import 'reflect-metadata';
import { startIngestApp } from './ingest/ingest.bootstrap.js';

// The device receiver as its own process (production): `node dist/ingest-main.js`.
await startIngestApp();
