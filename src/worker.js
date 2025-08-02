import './config.js'; // Load environment variables first
import { Worker } from 'bullmq';
import { processSermon } from './processing.js';
import { workerConnection } from './redis.js';

const worker = new Worker('sermon-processing', async (job) => {
  const { sermon } = job.data;
  console.log(`Processing sermon with audio: ${sermon.audioUrl}`);
  try {
    await processSermon(sermon, job);
    console.log(`Finished processing sermon with audio: ${sermon.audioUrl}`);
  } catch (error) {
    console.error(`Failed to process sermon with audio: ${sermon.audioUrl}`, error);
    throw error;
  }
}, { 
  connection: workerConnection,
  concurrency: 5, // Process up to 5 jobs concurrently
  // Allow jobs to run for up to 10 minutes
  lockDuration: 600000, 
  // If a job fails, retry it up to 3 times
  attempts: 3,
  // Use exponential backoff for retries, starting with a 5-second delay
  backoff: { type: 'exponential', delay: 5000 } 
});

console.log('Worker started and waiting for jobs...');

// Add event listeners for worker for better error reporting
worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed.`);
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