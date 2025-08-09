import './config.js'; // Load environment variables first
import { Worker } from 'bullmq';
import { processSermon } from './processing.js';
import { createAudioUrlIndex } from '../create-index.js';
import { workerConnection } from './redis.js';

const worker = new Worker('sermon-processing', async (job) => {
  if (job.name === 'process-sermon') {
    const { sermon } = job.data;
    console.log(`Processing sermon with audio: ${sermon.audioUrl}`);
    try {
      await processSermon(sermon, job);
      console.log(`Finished processing sermon with audio: ${sermon.audioUrl}`);
    } catch (error) {
      console.error(`Failed to process sermon with audio: ${sermon.audioUrl}`, error);
      throw error;
    }
  } else if (job.name === 'reindex') {
    console.log('Starting re-indexing process via worker...');
    try {
      await createAudioUrlIndex();
      console.log('Re-indexing process completed successfully via worker.');
    } catch (error) {
      console.error('Re-indexing process failed via worker:', error);
      throw error;
    }
  } else {
    console.warn(`Unknown job type: ${job.name}`);
  }
}, { 
  connection: workerConnection,
  concurrency: 5, // Process up to 5 jobs concurrently
  // Allow jobs to run for up to 30 minutes
  lockDuration: 1800000, 
  // If a job fails, retry it up to 3 times
  attempts: 3,
  // Use exponential backoff for retries, starting with a 5-second delay
  backoff: { type: 'exponential', delay: 5000 } 
});

console.log('Worker started and waiting for jobs...');

// Add event listeners for worker for better error reporting
worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed successfully. Result:`, result);
});

worker.on('progress', (job, progress) => {
    console.log(`Job ${job.id} is reporting progress:`, progress);
});

worker.on('stalled', (jobId) => {
    console.warn(`Job ${jobId} has stalled.`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error: ${err.message}`);
  if (job.stacktrace) {
    console.error('Stacktrace:', job.stacktrace);
  }
});

worker.on('error', (err) => {
  // General worker errors (e.g., Redis connection issues)
  console.error('Worker experienced an error:', err.message);
});

const gracefulShutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Shutting down worker...`);
  await worker.close();
  console.log('Worker has been closed.');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));