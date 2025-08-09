

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { alignText } from './align.js';
import { withRetry } from './retry.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fetch from 'node-fetch';
import Replicate from 'replicate';
import fs from 'fs/promises';
import path from 'path';
import Redis from 'ioredis';


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

const uploadToR2 = async (fileName, data) => {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  });

  try {
    await withRetry(() => getS3Client().send(command), {
      onRetry: (error, attempt) => {
        console.warn(`R2 upload attempt ${attempt} failed for ${fileName}. Retrying...`, error.message);
      }
    });
    console.log(`Successfully uploaded ${fileName} to R2.`);
  } catch (error) {
    console.error(`Error uploading ${fileName} to R2:`, error);
    throw error; // Re-throw to allow the job to be marked as failed if R2 upload fails
  }
};

const BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET_NAME;

const redis = new Redis(process.env.REDIS_URL);

const updateAudioUrlIndex = async (audioUrl, sermonId) => {
    try {
        await redis.hset('audio_url_index', audioUrl, sermonId);
        console.log(`Redis audio URL index updated successfully for ${audioUrl}.`);
    } catch (error) {
        console.error('Error updating the Redis audio URL index:', error);
        throw error; // Re-throw to mark the job as failed
    }
};

const cleanPdfText = (text) => {
  const delimiters = ['', '`']; // Check for both delimiters
  let contentAfterDelimiter = '';
  let foundDelimiter = false;

  for (const delimiter of delimiters) {
    const index = text.indexOf(delimiter);
    if (index !== -1) {
      contentAfterDelimiter = text.substring(index + delimiter.length).trim();
      foundDelimiter = true;
      break;
    }
  }

  if (foundDelimiter) {
    console.log("Delimiter found. Cleaning PDF text...");
    if (contentAfterDelimiter) {
      return contentAfterDelimiter;
    }
    throw new MissingDelimiterError('PDF content after delimiter is empty.');
  }
  
  throw new MissingDelimiterError(`Neither of the expected delimiters ('' or ``) found in PDF.`);
};

const generateRandomId = (length = 6) => {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
};

const extractTitleFromPdf = async (pdfData) => {
  let firstPage;
  try {
    firstPage = await pdfData.getPage(1);
    const textContent = await firstPage.getTextContent();
    const rawText = textContent.items.map(item => item.str).join(' ');
    console.log('Raw text from PDF (first page):', rawText.substring(0, 500) + '...'); // Log first 500 chars
    const delimiters = ['', '`']; // Check for both delimiters
    let title = 'Untitled';

    for (const delimiter of delimiters) {
      const parts = rawText.split(delimiter);
      if (parts.length >= 2) {
        title = parts[0].trim();
        break;
      }
    }
    return title.replace(/\s+/g, ' ').trim() || 'Untitled';
  } catch (error) {
    console.error("Failed to extract title from PDF:", error);
    return 'Untitled';
  } finally {
    if (firstPage) {
      firstPage.cleanup();
    }
  }
};



export const processSermon = async (sermon, job) => {
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });

  try {
    // Process PDF
    const pdfBuffer = await withRetry(async () => {
      const pdfResponse = await fetch(sermon.pdfUrl);
      if (!pdfResponse.ok) {
        throw new Error(`Failed to fetch PDF with status: ${pdfResponse.statusText}`);
      }
      return pdfResponse.arrayBuffer();
    }, {
      onRetry: (error, attempt) => console.warn(`PDF fetch attempt ${attempt} failed. Retrying...`, error.message)
    });

    const pdfData = await pdfjsLib.getDocument(pdfBuffer).promise;

    const title = await extractTitleFromPdf(pdfData);

    const numPages = pdfData.numPages;
    let pdfText = '';
    for (let i = 1; i <= numPages; i++) {
      const page = await pdfData.getPage(i);
      const textContent = await page.getTextContent();
      pdfText += textContent.items.map(item => item.str).join(' ');
      page.cleanup();
    }
    const cleanedText = cleanPdfText(pdfText);
    pdfData.destroy();

    // Transcribe Audio
    console.log(`Starting transcription for ${sermon.audioUrl}...`);
    const replicatePrediction = await withRetry(() => replicate.predictions.create({
        version: '1395a1d7aa48a01094887250475f384d4bae08fd0616f9c405bb81d4174597ea',
        input: {
            audio_file: sermon.audioUrl,
            language: sermon.language,
            align_output: true,
        },
    }), {
        onRetry: (error, attempt) => console.warn(`Replicate create prediction attempt ${attempt} failed. Retrying...`, error.message)
    });

    let transcription;
    const POLLING_INTERVAL_MS = 30000; // 30 seconds
    const LOCK_EXTENSION_MS = 300000; // 5 minutes

    while (true) {
      // The job object might not be available if called from a context other than a BullMQ worker.
      if (job && typeof job.extendLock === 'function') {
        await job.extendLock(LOCK_EXTENSION_MS);
        console.log(`Extended lock for job ${job.id}`);
      }

      const status = await withRetry(() => replicate.predictions.get(replicatePrediction.id), {
        onRetry: (error, attempt) => {
            console.warn(`Replicate get prediction status attempt ${attempt} failed. Retrying...`, error.message);
        }
      });

      if (status.status === 'succeeded') {
        console.log('Transcription succeeded.');
        transcription = status.output;
        break;
      } else if (status.status === 'failed' || status.status === 'canceled') {
        const errorMessage = `Replicate prediction failed with status: ${status.status}. Error: ${status.error}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
      
      console.log(`Transcription status: ${status.status}. Polling again in ${POLLING_INTERVAL_MS / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    if (!transcription || !transcription.segments) {
      console.error("\n--- Transcription Failed ---");
      console.error("The transcription service did not return a valid result for the following sermon:");
      console.error(JSON.stringify(sermon, null, 2));
      console.error("--- End of Error Report ---\n");
      // We will not re-throw here, as this is a data issue, not a system issue.
      // The job will be marked as completed, but no output will be generated.
      return; 
    }

    // Force the detected language to match the input language
    transcription.detected_language = sermon.language;

    const alignment = alignText(cleanedText, transcription, sermon.language);

    // New Filename and ID Generation
    const safeTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9\s_]/g, '') // Remove all non-alphanumeric, non-space, non-underscore characters
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/^_|_$/g, '') // Remove leading/trailing underscores
        .substring(0, 100); // Truncate to 100 characters
    const randomId = generateRandomId();
    const newSermonId = `${safeTitle}_${sermon.language}_${randomId}`;

    const processedData = {
      id: newSermonId,
      title: title, // Keep the original title for display
      pdfText: cleanedText,
      transcription,
      alignment,
      audioUrl: sermon.audioUrl,
    };

    await uploadToR2(`${newSermonId}.json`, processedData);

    // After successful upload, update the index
    console.log(`Attempting to update Redis audio_url_index for audioUrl: ${sermon.audioUrl} with sermonId: ${newSermonId}`);
    await updateAudioUrlIndex(sermon.audioUrl, newSermonId);
    console.log(`Successfully updated Redis audio_url_index for ${sermon.audioUrl}.`);

    // Store sermon metadata in a separate Redis hash for frontend display/search
    console.log(`Attempting to store sermon_metadata for sermonId: ${newSermonId} with title: ${title} and audioUrl: ${sermon.audioUrl}`);
    await redis.hmset(newSermonId, 'title', title, 'audioUrl', sermon.audioUrl);
    console.log(`Redis sermon_metadata updated successfully for ${newSermonId}.`);

  } catch (error) {
    if (error.name === 'InvalidPDFException') {
      console.error("\n--- Invalid PDF Detected ---");
      console.error("The application attempted to process a file as a PDF, but it appears to be an audio file or is otherwise invalid.");
      console.error("Please check the following sermon data in your input file and ensure the 'pdfUrl' points to a valid PDF:");
      console.error(JSON.stringify(sermon, null, 2));
      console.error("--- End of Error Report ---\n");
    } else if (error.name === 'MissingDelimiterError') {
        console.error(`\n--- PDF Processing Error for ${sermon.audioUrl} ---`);
        console.error(`Error: ${error.message}`);
        console.error("This usually means the PDF is not formatted correctly with the required '' delimiter.");
        console.error("Please check the following sermon data and the corresponding PDF file:");
        console.error(JSON.stringify(sermon, null, 2));
        console.error("--- End of Error Report ---\n");
    } else if (error.name === 'LockTimeoutError') {
        console.error(`\n--- Locking Error for ${sermon.audioUrl} ---`);
        console.error(`Error: ${error.message}`);
        console.error("This means the process could not acquire the lock to update the index file in time.");
        console.error("This could be due to high server load or a stalled process.");
        console.error("The job will be retried automatically.");
        console.error("--- End of Error Report ---\n");
    }
    else {
      console.error(`Error processing ${sermon.audioUrl}:`, error);
    }
    throw error; // Re-throw the error to mark the job as failed in BullMQ
  }
};