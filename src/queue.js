import { Queue, QueueEvents } from 'bullmq';
import { queueConnection, workerConnection } from './redis.js';

// Create and export a single, shared queue instance
export const sermonQueue = new Queue('sermon-processing', { connection: queueConnection });

export const sermonQueueEvents = new QueueEvents('sermon-processing', { connection: workerConnection });

