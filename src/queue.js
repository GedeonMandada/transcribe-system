import { Queue } from 'bullmq';
import { connection } from './redis.js';

// Create and export a single, shared queue instance
export const sermonQueue = new Queue('sermon-processing', { connection });

