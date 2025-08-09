import './config.js'; // Load environment variables first
import express from 'express';
import cors from 'cors';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { withRetry } from './retry.js';
import { sermonQueue, sermonQueueEvents } from './queue.js';
import axios from 'axios';
import FormData from 'form-data';
import stream from 'stream';
import fs from 'fs/promises';
import path from 'path';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);


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

app.post('/api/sermons/refresh-cache', (req, res) => {
    console.log('Received request to refresh cache (no-op for Redis index).');
    res.status(200).send({ message: 'Cache refresh request received. Redis index is not cleared by this action.' });
});

app.get('/api/sermons', async (req, res) => {
  try {
    const allAudioUrlToSermonIdMap = await redis.hgetall('audio_url_index'); // { audioUrl: sermonId, ... }

    const sermonPromises = Object.values(allAudioUrlToSermonIdMap).map(async (sermonId) => {
      const metadata = await redis.hgetall(sermonId); // { title: '...', audioUrl: '...' }
      if (metadata && metadata.title && metadata.audioUrl) {
        return { id: sermonId, title: metadata.title, audioUrl: metadata.audioUrl };
      }
      return null; // Filter out incomplete entries
    });

    const sermonsArray = (await Promise.all(sermonPromises)).filter(Boolean);

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    const results = {
        sermons: sermonsArray.slice(startIndex, endIndex),
        total: sermonsArray.length,
        page,
        limit,
        totalPages: Math.ceil(sermonsArray.length / limit),
    };

    res.send(results);

  } catch (error) {
    console.error('Error listing sermons from Redis:', error);
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

app.get('/api/app-sermons/by-audio-url', async (req, res) => {
  const audioUrlQuery = req.query.url;

  if (!audioUrlQuery) {
    return res.status(400).send({ message: 'The "url" query parameter is required.' });
  }

  const query = audioUrlQuery.toLowerCase();
  console.log(`[DEEP DEBUG] Starting search for query: "${query}"`);

  try {
    // Replicating the exact logic from sermons.html: fetch all and perform an "includes" search.
    
    // 1. Fetch all sermon IDs.
    const allAudioUrlToSermonIdMap = await redis.hgetall('audio_url_index');
    if (!allAudioUrlToSermonIdMap) {
        return res.status(404).send({ message: 'Sermon index is empty.' });
    }

    // 2. Fetch metadata for all sermons.
    const sermonPromises = Object.values(allAudioUrlToSermonIdMap).map(async (sermonId) => {
      const metadata = await redis.hgetall(sermonId);
      if (metadata && metadata.title && metadata.audioUrl) {
        return { id: sermonId, title: metadata.title, audioUrl: metadata.audioUrl };
      }
      return null;
    });
    const allSermons = (await Promise.all(sermonPromises)).filter(Boolean);
    console.log(`[DEEP DEBUG] Found ${allSermons.length} total sermons to search through.`);

    // 3. Find the specific sermon by filtering with the correct "includes" logic.
    const filteredSermons = allSermons.filter(sermon => {
        return sermon.audioUrl && sermon.audioUrl.toLowerCase().includes(query);
    });

    if (filteredSermons.length === 0) {
      const debugInfo = {
        message: "Sermon not found. The server could not find a match for your query.",
        yourQuery: audioUrlQuery,
        processedQuery: query,
        totalSermonsSearched: allSermons.length,
        urlsSearched: allSermons.map(s => s.audioUrl)
      };
      return res.status(404).send(debugInfo);
    }

    // 4. Get the first match, just like the search script.
    const foundSermon = filteredSermons[0];
    console.log(`[DEEP DEBUG] Search succeeded. Found sermon with ID: ${foundSermon.id}`);

    // 5. Now that we have the correct ID, fetch the full object from R2.
    const { Body } = await withRetry(async () => {
      const getObjectCommand = new GetObjectCommand({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
        Key: `${foundSermon.id}.json`,
      });
      return getS3Client().send(getObjectCommand);
    });

    if (!Body) {
      return res.status(404).send({ message: 'Sermon data not found in storage, though it was found in the index.' });
    }

    const data = await Body.transformToString();
    res.send(JSON.parse(data));

  } catch (error) {
    console.error(`Error fetching sermon by audio URL query ${audioUrlQuery}:`, error);
    if (error.name === 'NoSuchKey') {
      res.status(404).send({ message: 'Sermon data not found in storage.' });
    } else {
      res.status(500).send({ message: 'An error occurred while fetching sermon data.' });
    }
  }
});



app.get('/api/sermons/:id/vtt', async (req, res) => {
    const sermonId = req.params.id;
    try {
        // 1. Fetch JSON from R2
        const { Body } = await withRetry(async () => {
            const getObjectCommand = new GetObjectCommand({
                Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
                Key: `${sermonId}.json`,
            });
            return getS3Client().send(getObjectCommand);
        });

        if (!Body) {
            return res.status(404).send('Sermon JSON not found.');
        }

        // Buffer the stream into memory
        const jsonBuffer = await Body.transformToByteArray();

        // 2. Prepare data for the VTT API
        const formData = new FormData();
        formData.append('file', Buffer.from(jsonBuffer), {
            filename: `${sermonId}.json`,
            contentType: 'application/json',
        });

        // 3. Call the external VTT API
        const vttApiResponse = await axios.post('https://api-vtt.onrender.com/upload-json', formData, {
            headers: {
                ...formData.getHeaders(),
                'Accept': 'text/vtt',
            },
            responseType: 'stream',
        });

        // 4. Stream the VTT response to the client
        res.setHeader('Content-Type', 'text/vtt');
        vttApiResponse.data.pipe(res);

    } catch (error) {
        console.error(`Error generating VTT for sermon ${sermonId}:`, error.message);
        if (error.response) {
            console.error('VTT API Error Response:', error.response.data);
            res.status(error.response.status).send('Error from VTT API');
        } else if (error.name === 'NoSuchKey') {
            res.status(404).send('Sermon not found');
        } else {
            res.status(500).send('Error generating VTT');
        }
    }
});




app.post('/api/admin/clear-index', async (req, res) => {
    console.log('Received request to clear Redis index.');
    try {
        await redis.del('audio_url_index');
        await redis.del('sermon_metadata');
        console.log('Redis indexes cleared.');
        res.status(200).send({ message: 'Redis indexes cleared successfully.' });
    } catch (error) {
        console.error('Error clearing Redis indexes:', error);
        res.status(500).send({ message: 'Error clearing Redis indexes.' });
    }
});

app.post('/api/admin/reindex', async (req, res) => {
    console.log('Received request to re-index. Adding job to queue...');
    try {
        await sermonQueue.add('reindex', {});
        res.status(202).send({ message: 'Re-indexing job added to queue.' });
    } catch (error) {
        console.error('Error adding re-index job to queue:', error);
        res.status(500).send({ message: 'Error adding re-index job to queue.' });
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