/**
 * Upload routes accept bare base64 file bytes. Browsers read files as data
 * URLs whose media type comes from the File and may be empty (an iPhone photo
 * picked without a type reads as `data:application/octet-stream;base64,`), so
 * the prefix is removed regardless of what it names.
 */
const DATA_URL_BASE64_PREFIX = /^data:[^,]*;base64,/i;

/** The base64 payload of a data URL, or the value itself when it has none. */
export function base64Payload(value: string): string {
  return value.replace(DATA_URL_BASE64_PREFIX, '');
}

/** Read a file's bytes as bare base64 for an upload route. */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(base64Payload(String(reader.result)));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
