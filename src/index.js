import './config.js'; // Load environment variables first
import express from 'express';
import cors from 'cors';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { withRetry } from './retry.js';
import { sermonQueue } from './queue.js';

const app = express();
const port = process.env.PORT || 3000;

let s3Client;
const getS3Client = () => {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.CLOUDFLARE_R2_ENDPOINT_URL,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
};

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

app.post('/api/sermons/bulk', async (req, res) => {
  const { sermons } = req.body;
  if (!sermons || !Array.isArray(sermons)) {
    return res.status(400).send({ message: 'Invalid request body' });
  }

  for (const sermon of sermons) {
    await sermonQueue.add('process-sermon', { sermon });
  }

  res.status(202).send({ message: 'Sermon processing started in the background.' });
});

app.get('/api/sermons', async (req, res) => {
  try {
    const { Contents } = await withRetry(async () => {
      const command = new ListObjectsV2Command({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
      });
      return getS3Client().send(command);
    }, {
      onRetry: (error, attempt) => console.warn(`R2 list objects attempt ${attempt} failed. Retrying...`, error.message)
    });

    if (!Contents) {
      return res.send([]);
    }

    const sermons = await Promise.all(
      Contents.map(async (object) => {
         return withRetry(async () => {
          const getObjectCommand = new GetObjectCommand({
            Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
            Key: object.Key,
          });
          const { Body } = await getS3Client().send(getObjectCommand);
          const data = await Body.transformToString();
          return JSON.parse(data);
        }, {
          onRetry: (error, attempt) => console.warn(`R2 get object "${object.Key}" attempt ${attempt} failed. Retrying...`, error.message)
        });
      })
    );

    res.send(sermons);
  } catch (error) {
    console.error('Error fetching sermons from R2:', error);
    res.status(500).send({ message: 'Error fetching sermons' });
  }
});

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

export default app;
