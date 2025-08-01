import '../config.js'; // Ensures env vars are loaded
import Redis from 'ioredis';

const redisOptions = {
 // A robust retry strategy for reconnecting. This will try to reconnect
  // with an exponential backoff, which is great for production.
  retryStrategy(times) {
    // Wait 500ms, 1s, 2s, 4s, ... up to a max of 10 seconds between retries.
    const delay = Math.min(times * 500, 10000);
    console.log(`Redis: Retrying connection, attempt ${times}, delay ${delay}ms`);
    return delay;
  },
  // Set a max number of retries for a single command.
  maxRetriesPerRequest: 3,
   // The number of times to retry a command before failing.
  // The previous value of 3 was too low for unstable connections.
  // We are now leaving it at the ioredis default (20), which is more resilient.
  
  // Avoids throwing an error on startup if Redis is not immediately available.
  lazyConnect: true,
};

// Create and export a single, shared Redis connection
export const connection = new Redis(process.env.REDIS_URL, redisOptions);

connection.on('connect', () => {
  console.log('Redis: Connection established.');
});

// This is the crucial part: listen for errors to prevent unhandled exceptions.
connection.on('error', (err) => {
  console.error('Redis: Connection error:', err.message);
});