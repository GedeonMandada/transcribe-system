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

  // Initialize DP table
  const dp = Array(pdfWords.length + 1)
    .fill(null)
    .map(() => Array(transcribedWords.length + 1).fill(0));

  // Fill DP table
  for (let i = 1; i <= pdfWords.length; i++) {
    for (let j = 1; j <= transcribedWords.length; j++) {
      if (pdfWords[i - 1].normalized === transcribedWords[j - 1].word) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the alignment for every original PDF word
  const alignedText = [];
  let i = pdfWords.length;
  let j = transcribedWords.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1 && pdfWords[i - 1].normalized === transcribedWords[j - 1].word) {
      // Match found, use original PDF word with transcription timing
      alignedText.unshift({
        word: pdfWords[i - 1].original,
        startTime: transcribedWords[j - 1].startTime,
        endTime: transcribedWords[j - 1].endTime,
        chunk: transcribedWords[j-1].chunk
      });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || (dp[i - 1][j] >= (dp[i][j-1] || 0)))) {
      // Word exists in PDF but not in transcription, preserve it
      alignedText.unshift({
        word: pdfWords[i - 1].original,
        startTime: null,
        endTime: null,
        chunk: null
      });
      i--;
    } else if (j > 0) {
      // Word exists in transcription but not in PDF, skip it
      j--;
    } else {
      // Should not be reached
      break;
    }
  }

  return { alignedText };
};

