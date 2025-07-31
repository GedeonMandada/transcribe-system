import '../config.js'; // Load environment variables first
import { Worker } from 'bullmq';
import { processSermon } from './processing.js';
import { connection } from './redis.js';

new Worker('sermon-processing', async (job) => {
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
  connection,
  concurrency: 5, // Process up to 5 jobs concurrently
  // Allow jobs to run for up to 10 minutes
  lockDuration: 600000, 
  // If a job fails, retry it up to 3 times
  attempts: 3,
  // Use exponential backoff for retries, starting with a 5-second delay
  backoff: { type: 'exponential', delay: 5000 } 
});

console.log('Worker started and waiting for jobs...');