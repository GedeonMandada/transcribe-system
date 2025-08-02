import './config.js'; // Ensures env vars are loaded
import Redis from 'ioredis';

const sharedRedisOptions = {
  // A robust retry strategy for reconnecting.
  retryStrategy(times) {
    const delay = Math.min(times * 500, 10000);
    console.log(`Redis: Retrying connection, attempt ${times}, delay ${delay}ms`);
    return delay;
  },
  lazyConnect: true,
  keepAlive: 10000, // Keep connection alive by sending PING every 10 seconds
};

// This client is for non-blocking commands (e.g., adding jobs to the queue).
// It can have a limit on retries per request.
export const queueConnection = new Redis(process.env.REDIS_URL, {
  ...sharedRedisOptions,
  maxRetriesPerRequest: 10, // Increased for better resilience on Render's free tier
});

// This client is specifically for the BullMQ Worker.
// BullMQ requires `maxRetriesPerRequest: null` for its blocking commands.
export const workerConnection = new Redis(process.env.REDIS_URL, {
  ...sharedRedisOptions,
  maxRetriesPerRequest: null, // This is required by BullMQ
});

const setupEventListeners = (client, name) => {
  client.on('connect', () => {
    console.log(`Redis (${name}): Connection established.`);
  });
  client.on('error', (err) => {
    console.error(`Redis (${name}): Connection error:`, err.message);
  });
};

setupEventListeners(queueConnection, 'Queue/API');
setupEventListeners(workerConnection, 'Worker');