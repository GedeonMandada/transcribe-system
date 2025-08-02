import './config.js'; // Load environment variables first
import express from 'express';
import cors from 'cors';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { withRetry } from './retry.js';
import { sermonQueue, sermonQueueEvents } from './queue.js';

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

const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
};

app.post('/api/sermons/bulk', async (req, res) => {
  const { sermons } = req.body;
  if (!sermons || !Array.isArray(sermons) || sermons.length === 0) {
    return res.status(400).send({ message: 'Invalid request body: "sermons" array is missing or empty.' });
  }

  const submittedJobs = [];
  for (const sermon of sermons) {
    if (!sermon.pdfUrl || !isValidUrl(sermon.pdfUrl)) {
      return res.status(400).send({ message: `Invalid PDF URL: ${sermon.pdfUrl}` });
    }
    if (!sermon.audioUrl || !isValidUrl(sermon.audioUrl)) {
      return res.status(400).send({ message: `Invalid Audio URL: ${sermon.audioUrl}` });
    }
    if (!sermon.language) {
      return res.status(400).send({ message: 'Language is required for each sermon.' });
    }

    const job = await sermonQueue.add('process-sermon', { sermon });
    submittedJobs.push({ jobId: job.id, status: 'queued', sermon: sermon });
  }

  res.status(202).send({ message: 'Sermon processing started in the background.', jobs: submittedJobs });
});

app.get('/api/sermons/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await sermonQueue.getJob(jobId);

    if (!job) {
      return res.status(404).send({ message: 'Job not found.' });
    }

    const state = await job.getState();
    res.send({
      jobId: job.id,
      status: state,
      data: job.data.sermon,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
    });
  } catch (error) {
    console.error(`Error fetching job status for ${jobId}:`, error);
    res.status(500).send({ message: 'Error fetching job status.' });
  }
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

    // Only return metadata (id and title) to avoid memory issues
    const sermonsMetadata = Contents.map(object => {
      const id = object.Key.replace('.json', ''); // Assuming filename is the ID
      // Attempt to extract title from the ID, or use a default
      const parts = id.split('_');
      const title = parts.slice(0, -2).join(' ').replace(/_/g, ' ') || 'Untitled Sermon'; // Remove last two parts (language and random ID)
      return { id, title };
    });

    res.send(sermonsMetadata);
  } catch (error) {
    console.error('Error listing sermons from R2:', error);
    res.status(500).send({ message: 'Error listing sermons' });
  }
});

app.get('/api/sermons/:id', async (req, res) => {
  const sermonId = req.params.id;
  try {
    const { Body } = await withRetry(async () => {
      const getObjectCommand = new GetObjectCommand({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
        Key: `${sermonId}.json`,
      });
      return getS3Client().send(getObjectCommand);
    }, {
      onRetry: (error, attempt) => console.warn(`R2 get object "${sermonId}.json" attempt ${attempt} failed. Retrying...`, error.message)
    });

    if (!Body) {
      return res.status(404).send({ message: 'Sermon not found' });
    }

    const data = await Body.transformToString();
    res.send(JSON.parse(data));
  } catch (error) {
    console.error(`Error fetching sermon ${sermonId} from R2:`, error);
    if (error.name === 'NoSuchKey') {
      res.status(404).send({ message: 'Sermon not found' });
    } else {
      res.status(500).send({ message: 'Error fetching sermon' });
    }
  }
});

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack); // Log the error stack for debugging
  res.status(500).send({ message: 'Something broke!', error: err.message });
});

const server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

const gracefulShutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed.');

    // Close the queue connection
    try {
      await sermonQueue.close();
      console.log('BullMQ queue connection closed.');
    } catch (err) {
      console.error('Error closing BullMQ queue:', err);
    }

    // exit the process
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
