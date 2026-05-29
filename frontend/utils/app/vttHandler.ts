export interface VTTReference {
  vttId: string;
  sessionId: string;
  filename?: string;
  mimeType?: string;
}

// Upload VTT content to Redis and return reference
export async function uploadVTT(
  content: string,
  filename: string,
  mimeType: string = 'text/vtt',
  signal?: AbortSignal,
): Promise<VTTReference> {
  try {
    const response = await fetch('/api/session/vttStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, filename, mimeType }),
      credentials: 'include',
      signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const error = await response.json();
        detail = error.error || '';
      } catch {
        // ignore parse failure
      }
      const message =
        response.status === 413
          ? 'File exceeds the size limit.'
          : response.status === 415
          ? 'Unsupported transcript format.'
          : detail || `Failed to upload VTT (HTTP ${response.status})`;
      throw new Error(message);
    }

    const { vttId, sessionId } = await response.json();
    return { vttId, sessionId, filename, mimeType };
  } catch (error) {
    console.error('Error uploading VTT:', error);
    throw error;
  }
}

// Upload VTT file from File object
export async function uploadVTTFile(
  file: File,
  signal?: AbortSignal,
): Promise<VTTReference> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    const onAbort = () => {
      reader.abort();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    reader.onload = async () => {
      try {
        const content = reader.result as string;
        const vttRef = await uploadVTT(
          content,
          file.name,
          file.type || 'text/vtt',
          signal,
        );
        resolve(vttRef);
      } catch (error) {
        reject(error);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    };

    reader.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Failed to read VTT file'));
    };

    reader.readAsText(file);
  });
}

// Check if a file is a VTT file
export function isVTTFile(file: File): boolean {
  const vttExtensions = ['.vtt', '.webvtt', '.srt'];
  const vttMimeTypes = ['text/vtt', 'application/x-subrip'];

  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  const mimeType = file.type.toLowerCase();
  const isVTTExtension = vttExtensions.includes(extension);
  const isVTTMimeType = vttMimeTypes.includes(mimeType);

  return isVTTExtension || isVTTMimeType;
}
