export const isReaderFrame = (value) =>
  typeof value === 'string' && value.length === 10 && /^[0-9]{10}$/.test(value);

export const READER_MASK = '[reader identifier]';

// Redact identifier fields at presentation boundaries without changing numeric telemetry.
export const maskReaderText = (text) =>
  text.replace(/("(?:idTag|parentIdTag)"\s*:\s*")[0-9]{10}(")/g, '$1[reader identifier]$2');
