import 'reflect-metadata';
import { startApi } from './api.bootstrap.js';

// The API (`node dist/main.js`); the device receiver too in development (api.bootstrap.ts).
await startApi();
