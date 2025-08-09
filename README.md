# Sermon Processing and Alignment Service

This project is a robust, queue-based Node.js application designed to process and align sermon audio with its corresponding PDF transcript. It uses the Replicate API for AI-powered audio transcription, BullMQ for managing background jobs, and Cloudflare R2 for storing the final processed data. Sermon metadata is efficiently indexed and retrieved using Redis.

The system is built to be resilient, handling long-running tasks and transient network errors gracefully, and is configured for easy deployment on Render.com.

## Table of Contents

- [Features](#features)
- [Architecture)
- [Technology Stack](#technology-stack)
- [Local Development Setup](#local-development-setup)
- [Admin Features (Frontend)](#admin-features-frontend)
- [API Endpoints](#api-endpoints)
- [Deployment to Render.com](#deployment-to-rendercom)
- [Key Design Decisions](#key-design-decisions)

## Features

- **Bulk Job Submission**: Add multiple sermons for processing via a single REST API call.
- **Asynchronous Processing**: Leverages a BullMQ queue with a Redis backend to process jobs in the background without blocking the API.
- **AI-Powered Transcription**: Uses the [WhisperX model on Replicate](https://replicate.com/victor-upmeet/whisperx-a40-large) for accurate, timestamped audio transcription.
- **Text and Audio Alignment**: Intelligently aligns the text extracted from PDF files with the transcribed audio words, with improved delimiter detection.
- **Long-Running Job Support**: Can process audio files that are hours long by actively polling the Replicate API and extending the job lock in BullMQ to prevent timeouts.
- **Resilient Network Operations**: Automatically retries failed network requests (to Replicate, R2, or for fetching source files) with exponential backoff. R2 connections are now more robust for large indexing tasks.
- **Efficient Sermon Indexing**: Sermon metadata (ID, title, audio URL) is stored and retrieved from Redis, providing fast search and display capabilities.
- **Frontend Admin Controls**: Buttons on the frontend to clear the Redis index and trigger a full re-indexing process.
- **Graceful Shutdown**: The API server and worker are configured to shut down cleanly, finishing active jobs before exiting.
- **Cloud-Ready**: Optimized for deployment on Render.com's free tier.

## Architecture

The application consists of two main components that run concurrently: an API server and a background worker. Sermon metadata is stored in Redis, while the full processed sermon JSONs are stored in R2.

```
[Client] --(POST /api/sermons/bulk)--> [API Server (Express.js)]
                                             |\
                                             | (Adds job to queue)
                                             v
                                   [Redis (BullMQ Queue)]
                                             |\
                                             | (Pulls job)
                                             v
[Worker Process] <---------------------------|
      |\
      | 1. Fetch PDF & Audio from URLs (with retries)
      | 2. Call Replicate API for Transcription (with retries & polling)
      | 3. Align PDF text with transcription (improved delimiter detection)
      | 4. Upload final JSON to R2 (with retries)
      | 5. Update Redis Index (sermon_metadata & audio_url_index)
      v
[Cloudflare R2 Storage] <--(GET /api/sermons/:id)--> [API Server (Express.js)]
      ^
      |
[Redis (Sermon Metadata Index)] <--(GET /api/sermons)-- [API Server (Express.js)]
```

## Technology Stack

- **Backend**: Node.js, Express.js
- **Queueing**: BullMQ
- **Database/Broker**: Redis
- **Object Storage**: Cloudflare R2 (or any S3-compatible service)
- **AI Transcription**: Replicate API
- **PDF Parsing**: `pdf.js-dist`
- **Deployment**: Render.com
- **Development Utilities**: Nodemon, Dotenv, Concurrently

## Local Development Setup

### 1. Prerequisites
- Node.js (v20 or later recommended)
- A Redis instance (can be run locally via Docker or use a free cloud service like Upstash)
- API keys for Replicate and Cloudflare R2.

### 2. Installation

Clone the repository and install the dependencies:

```bash
git clone <your-repo-url>
cd replicate
npm install
```

### 3. Environment Variables

Create a `.env` file in the root of the project by copying the example below. Fill in your credentials.

```env
# .env.example

# Redis connection URL (e.g., from Upstash)
REDIS_URL="redis://..."

# Replicate API Token
REPLICATE_API_TOKEN="r8_..._..."

# Cloudflare R2 Credentials (or any S3-compatible service)
CLOUDFLARE_R2_ENDPOINT_URL="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
CLOUDFLARE_R2_ACCESS_KEY_ID="your_access_key_id"
CLOUDFLARE_R2_SECRET_ACCESS_KEY="your_secret_access_key"
CLOUDFLARE_R2_BUCKET_NAME="your_bucket_name"
```

### 4. Running the Application

You need to run the API server and the worker in two separate terminals.

**Terminal 1: Start the API Server**
```bash
npm start
```
This will start the Express server, typically on `http://localhost:3000`.

**Terminal 2: Start the Worker**
```bash
npm run worker
```
The worker will connect to the Redis queue and start waiting for jobs.

## Admin Features (Frontend)

Access these features by navigating to `http://localhost:3000/` in your browser.

- **Clear Redis Index**: This button calls `/api/admin/clear-index` which will delete all sermon metadata from your Redis instance. Use this to reset your sermon library.
- **Re-index Sermons**: This button calls `/api/admin/reindex` which adds a job to the BullMQ queue. The worker process will then read all sermon JSON files from your R2 bucket, extract their metadata, and re-populate the Redis index. This is useful for rebuilding the index if R2 data changes or after clearing the index.

## API Endpoints

### Submit Sermons for Processing

- **URL**: `/api/sermons/bulk`
- **Method**: `POST`
- **Description**: Adds one or more sermon jobs to the processing queue.
- **Request Body**: A JSON object containing an array of sermons. See `input.json` for an example.
  ```json
  {
    "sermons": [
      {
        "pdfUrl": "https://.../sermon.pdf",
        "audioUrl": "https://.../sermon.m4a",
        "language": "fr"
      }
    ]
  }
  ```
- **Success Response**:
  - **Code**: `202 Accepted`
  - **Content**: `{ "message": "Sermon processing started in the background.", "jobs": [...] }`

### Get Processed Sermons

- **URL**: `/api/sermons`
- **Method**: `GET`
- **Description**: Retrieves a paginated list of all processed sermon metadata from the Redis index.
- **Query Parameters**:
    - `page` (optional, default: 1): The page number to retrieve.
    - `limit` (optional, default: 20): The number of sermons per page.
- **Success Response**:
  - **Code**: `200 OK`
  - **Content**: A JSON object containing `sermons` (array of sermon metadata objects), `total` (total number of sermons), `page`, `limit`, and `totalPages`.

### Get Single Sermon Details

- **URL**: `/api/sermons/:id`
- **Method**: `GET`
- **Description**: Retrieves the full processed JSON data for a single sermon from R2.
- **Success Response**:
  - **Code**: `200 OK`
  - **Content**: The full JSON object of the processed sermon.

### Generate VTT (Subtitle) File

- **URL**: `/api/sermons/:id/vtt`
- **Method**: `GET`
- **Description**: Generates a WebVTT (subtitle) file for a given sermon by fetching its processed JSON from R2 and sending it to an external VTT API.
- **Success Response**:
  - **Code**: `200 OK`
  - **Content**: The WebVTT file content.

### Refresh Sermon Cache (No-op)

- **URL**: `/api/sermons/refresh-cache`
- **Method**: `POST`
- **Description**: This endpoint is now a no-op. It previously cleared an in-memory cache but no longer performs any action on the Redis index. The Redis index is updated automatically by the worker or via the "Re-index Sermons" admin action.

## Deployment to Render.com

This project is configured for a seamless deployment to Render using the `render.yaml` file.

### Deployment Strategy

To work within Render's free tier, the `render.yaml` file defines a single `web` service. This service uses the `concurrently` package to run both the API server (`npm:start:web:prod`) and the background worker (`npm:worker:prod`) in the same container.

### Steps to Deploy

1.  **Push to a Git Repository**: Ensure your project is pushed to a GitHub or GitLab repository.
2.  **Create a Blueprint on Render**:
    - In the Render Dashboard, click **New +** > **Blueprint**.
    - Connect the Git repository for this project. Render will automatically detect and use the `render.yaml` file.
3.  **Configure Environment Variables**:
    - Render will prompt you to create an Environment Group named `sermon-processing-env`.
    - Click on this group and add all the secret keys and URLs from your local `.env` file.
4.  **Deploy**:
    - Click **Apply**. Render will build and deploy your service. The first deployment will install `npm` packages and then run the `npm run start:prod` command.

Your service will be live at the URL provided by Render.

## Key Design Decisions

### Robust Redis Connections

The `src/redis.js` module creates two distinct `ioredis` clients:
1.  **`queueConnection`**: Used by the API server and for adding jobs. It has a `maxRetriesPerRequest` limit, making it fail faster for API-related tasks.
2.  **`workerConnection`**: Used by the BullMQ worker. It has `maxRetriesPerRequest: null`, which is a requirement for the worker's long-polling connection to Redis. This prevents the worker from crashing due to Redis client settings.

### Efficient Redis Indexing

Sermon metadata is now stored in Redis using a hash-of-hashes structure. The `audio_url_index` hash maps audio URLs to sermon IDs, and individual `sermonId` hashes store the `title` and `audioUrl`. This provides:
- **Atomic Updates**: `redis.hmset` ensures metadata is updated atomically.
- **Fast Retrieval**: `redis.hgetall` allows quick retrieval of all metadata for a given sermon ID.
- **Scalability**: Leverages Redis's in-memory speed for efficient indexing and retrieval, eliminating file system contention.

### Resilient Network Operations

The `src/retry.js` utility provides a `withRetry` function that wraps all critical network calls (fetching source files, calling Replicate, and interacting with R2). It catches common transient errors (like `ECONNRESET`) and retries the operation with an exponential backoff delay, making the entire processing pipeline much more stable. The `S3Client` is now re-initialized for each R2 operation during re-indexing to ensure fresh connections and prevent "Connection is closed" errors during long-running tasks.

### Handling Long-Running Transcriptions

Audio transcription can take a very long time. To handle this, the worker does not use a simple "fire-and-forget" approach. Instead, in `src/processing.js`, it:
1.  Initiates the transcription on Replicate using `replicate.predictions.create()`.
2.  Enters a `while` loop to poll the job status every 30 seconds using `replicate.predictions.get()`.
3.  Crucially, inside this loop, it calls `job.extendLock()` to inform BullMQ that the worker is still alive and making progress. This prevents the job from being marked as "stalled" and retried prematurely.
