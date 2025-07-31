import '../config.js'; // Ensures env vars are loaded
import Redis from 'ioredis';

// Create and export a single, shared Redis connection
export const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

