 import './src/config.js'; // Load environment variables
         import Redis from 'ioredis';
    
         const redisUrl = process.env.REDIS_URL;
    
         if (!redisUrl) {
           console.error('REDIS_URL environment variable is not set. Please ensure your .env file has REDIS_URL configured.');
           process.exit(1);
         }
   
        const redis = new Redis(redisUrl);
   
        redis.on('connect', async () => {
          console.log('Connected to Redis. Flushing database...');
          try {
            await redis.flushall();
            console.log('Redis database flushed successfully. All queues and data are cleared.');
          } catch (error) {
            console.error('Error flushing Redis database:', error);
          } finally {
            redis.disconnect();
            process.exit(0);
          }
        });
   
        redis.on('error', (err) => {
          console.error('Redis connection error:', err);
          process.exit(1);
        });
