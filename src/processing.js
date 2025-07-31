import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { alignText } from './align.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fetch from 'node-fetch';
import Replicate from 'replicate';

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
    Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
    Key: fileName,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  });

  try {
    await getS3Client().send(command);
    console.log(`Successfully uploaded ${fileName} to R2.`);
  } catch (error) {
    console.error(`Error uploading ${fileName} to R2:`, error);
  }
};

const cleanPdfText = (text) => {
  const delimiter = '';
  const parts = text.split(delimiter);

  if (parts.length > 2) {
    console.log("Delimiter found. Cleaning PDF text...");
    const result = parts[1].trim();
    if (result) {
      return result;
    }
    console.warn("Warning: PDF cleaning resulted in empty text, falling back to raw text.");
  } else {
    console.warn(`Warning: Delimiter '${delimiter}' not found in PDF or not found enough. Using raw text.`);
  }
  
  return text;
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
    const delimiter = '';
    const title = rawText.split(delimiter)[0].trim();
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
    const pdfResponse = await fetch(sermon.pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to fetch PDF with status: ${pdfResponse.statusText}`);
    }
    const pdfBuffer = await pdfResponse.arrayBuffer();

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
    const replicatePrediction = await replicate.predictions.create({
      version: '1395a1d7aa48a01094887250475f384d4bae08fd0616f9c405bb81d4174597ea',
      input: {
        audio_file: sermon.audioUrl,
        language: sermon.language,
        align_output: true,
      },
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

      const status = await replicate.predictions.get(replicatePrediction.id);

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
      return;
    }

    // Force the detected language to match the input language
    transcription.detected_language = sermon.language;

    const alignment = alignText(cleanedText, transcription, sermon.language);

    // New Filename and ID Generation
    const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
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

  } catch (error) {
    if (error.name === 'InvalidPDFException') {
      console.error("\n--- Invalid PDF Detected ---");
      console.error("The application attempted to process a file as a PDF, but it appears to be an audio file or is otherwise invalid.");
      console.error("Please check the following sermon data in your input file and ensure the 'pdfUrl' points to a valid PDF:");
      console.error(JSON.stringify(sermon, null, 2));
      console.error("--- End of Error Report ---\n");
    } else {
      console.error(`Error processing ${sermon.audioUrl}:`, error);
    }
  }
};