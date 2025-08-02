const normalize = (text) => {
  return text.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
};

const tokenize = (text) => {
  // Split by whitespace and filter out empty strings
  return text.split(/\s+/).filter(w => w.length > 0).map(word => ({
    original: word,
    normalized: normalize(word)
  }));
};

const getWordTimestamps = (transcription) => {
  const words = [];
  if (!transcription.segments) return words;

  for (const segment of transcription.segments) {
    if (segment.words) {
      for (const word of segment.words) {
        words.push({
          word: normalize(word.word),
          startTime: word.start,
          endTime: word.end,
          chunk: [segment.start, segment.end]
        });
      }
    }
  }
  return words;
};

export const alignText = (pdfText, transcription, language) => {
  const pdfWords = tokenize(pdfText);
  const transcribedWords = getWordTimestamps(transcription);

  const alignedText = [];
  let transcribedIdx = 0;

  // Define a search window to limit how far ahead we look for a match
  // This prevents excessive comparisons and keeps memory usage low.
  // Adjust this value based on expected word skips/insertions.
  const SEARCH_WINDOW = 100; // Look ahead up to 100 words in transcription

  for (let i = 0; i < pdfWords.length; i++) {
    const currentPdfWord = pdfWords[i];
    let foundMatch = false;

    // Search for the current PDF word in the remaining transcribed words within the window
    for (let j = transcribedIdx; j < Math.min(transcribedWords.length, transcribedIdx + SEARCH_WINDOW); j++) {
      if (currentPdfWord.normalized === transcribedWords[j].word) {
        // Match found
        alignedText.push({
          word: currentPdfWord.original,
          startTime: transcribedWords[j].startTime,
          endTime: transcribedWords[j].endTime,
          chunk: transcribedWords[j].chunk
        });
        transcribedIdx = j + 1; // Advance transcription pointer past the matched word
        foundMatch = true;
        break; // Move to the next PDF word
      }
    }

    if (!foundMatch) {
      // No match found for this PDF word in the search window
      // Add the PDF word without timestamp information
      alignedText.push({
        word: currentPdfWord.original,
        startTime: null,
        endTime: null,
        chunk: null
      });
    }
  }

  return { alignedText };
};

