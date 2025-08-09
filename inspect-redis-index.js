import './src/config.js'; // Load environment variables
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.error('REDIS_URL environment variable is not set.');
  process.exit(1);
}

const redis = new Redis(redisUrl);

redis.on('connect', async () => {
  console.log('Connected to Redis. Fetching audio_url_index...');
  try {
    const audioUrlIndex = await redis.hgetall('audio_url_index');
    if (Object.keys(audioUrlIndex).length > 0) {
      console.log('Redis audio_url_index contains:', audioUrlIndex);

      // Pick a sample sermonId from the audio_url_index
      const sampleAudioUrl = Object.keys(audioUrlIndex)[0];
      const sampleSermonId = audioUrlIndex[sampleAudioUrl];

      console.log(`\nFetching sermon_metadata for sample sermonId: ${sampleSermonId}`);
      const sermonMetadata = await redis.hgetall(sampleSermonId);

      if (Object.keys(sermonMetadata).length > 0) {
        console.log('Sermon metadata object:', sermonMetadata);
      } else {
        console.log(`No sermon_metadata found for ${sampleSermonId}.`);
      }

    } else {
      console.log('Redis audio_url_index is empty.');
    }
  } catch (error) {
    console.error('Error fetching data from Redis:', error);
  } finally {
    redis.disconnect();
    process.exit(0);
  }
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
  process.exit(1);
});