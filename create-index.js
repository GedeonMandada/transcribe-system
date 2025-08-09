// create-index.js
import './src/config.js'; // Load environment variables
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import Redis from 'ioredis';
import { withRetry } from './src/retry.js';

// --- S3 Client Initialization ---
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT_URL,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
  httpOptions: {
    timeout: 60000, // 60 seconds for overall request timeout
    connectTimeout: 15000, // 15 seconds for connection establishment
  },
});

const BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET_NAME;
const redis = new Redis(process.env.REDIS_URL);

// --- Main Indexing Function ---
export async function createAudioUrlIndex() {
  console.log('Starting index creation process...');

  try {
    // 1. Get a list of all JSON files in the bucket, handling pagination
    console.log('Fetching list of all sermon files from R2 (handling pagination)...');
    const allFiles = [];
    let continuationToken = undefined;
    let pageCount = 0;

    do {
      pageCount++;
      const { Contents, NextContinuationToken } = await withRetry(async () => {
        const s3Client = new S3Client({
          region: 'auto',
          endpoint: process.env.CLOUDFLARE_R2_ENDPOINT_URL,
          credentials: {
            accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
          },
          httpOptions: {
            timeout: 60000, // 60 seconds for overall request timeout
            connectTimeout: 15000, // 15 seconds for connection establishment
          },
        });
        const listCommand = new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          ContinuationToken: continuationToken,
        });
        const response = await s3Client.send(listCommand);
        s3Client.destroy(); // Destroy client after use
        return response;
      }, {
        onRetry: (error, attempt) => console.warn(`R2 list objects attempt ${attempt} failed. Retrying...`, error.message)
      });
      
      if (Contents) {
        console.log(`  - Fetched page ${pageCount}: ${Contents.length} files.`);
        allFiles.push(...Contents);
      }

      continuationToken = NextContinuationToken;
      if(continuationToken) console.log('Fetching next page of files...');

    } while (continuationToken);

    console.log(`Finished R2 listing. Total files found: ${allFiles.length}.`);

    if (allFiles.length === 0) {
      console.log('No files found in the bucket. Exiting.');
      return;
    }

    const sermonFiles = allFiles.filter(file => 
        file.Key.endsWith('.json') && file.Key !== 'audio_url_index.json'
    );

    console.log(`Found ${sermonFiles.length} total sermon files to process for indexing.`);

    // 2. Process each file sequentially for memory efficiency and update Redis
    let indexedCount = 0;
    for (let i = 0; i < sermonFiles.length; i++) {
      const file = sermonFiles[i];
      console.log(`Processing file ${i + 1} of ${sermonFiles.length}: ${file.Key}`);

      try {
        const s3Client = new S3Client({
          region: 'auto',
          endpoint: process.env.CLOUDFLARE_R2_ENDPOINT_URL,
          credentials: {
            accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
          },
          httpOptions: {
            timeout: 60000, // 60 seconds for overall request timeout
            connectTimeout: 15000, // 15 seconds for connection establishment
          },
        });
        const getObjectCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: file.Key });
        const { Body } = await withRetry(async () => {
          const getObjectCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: file.Key });
          return s3Client.send(getObjectCommand);
        }, {
          onRetry: (error, attempt) => console.warn(`R2 get object "${file.Key}" attempt ${attempt} failed. Retrying...`, error.message)
        });
        const fileContent = await Body.transformToString();
        const sermonData = JSON.parse(fileContent);

        // 3. Extract the required data and add it to Redis
        // The sermon ID is derived from the filename, which is the ultimate source of truth.
        const sermonIdFromFile = file.Key.replace('.json', '');

        if (sermonData.audioUrl && sermonData.title) {
          // Optional: Log if the ID inside the file doesn't match the filename
          if (sermonData.id && sermonData.id !== sermonIdFromFile) {
            console.warn(`  - Warning: ID mismatch in ${file.Key}. File content ID was '${sermonData.id}', but filename ID is '${sermonIdFromFile}'. Using the filename ID.`);
          }

          await redis.hset('audio_url_index', sermonData.audioUrl, sermonIdFromFile);
          await redis.hmset(sermonIdFromFile, 'title', sermonData.title, 'audioUrl', sermonData.audioUrl);
          indexedCount++;
        } else {
          console.warn(`  - Warning: Skipping ${file.Key} because it is missing 'audioUrl' or 'title'.`);
        }
      } catch (err) {
        console.error(`  - Error processing file ${file.Key}:`, err.message);
        // Continue to the next file even if one fails
      } finally {
        s3Client.destroy(); // Destroy client after use
      }
    }

    console.log(`\nSuccess! Redis index 'audio_url_index' was populated with ${indexedCount} entries.`);

  } catch (error) {
    console.error('\nAn unexpected error occurred during the indexing process:', error);
  } finally {
    redis.disconnect();
  }
}

