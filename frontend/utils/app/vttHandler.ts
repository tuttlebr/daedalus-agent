export interface VTTReference {
  vttId: string;
  sessionId: string;
  filename?: string;
  mimeType?: string;
}

export interface VTTListItem {
  id: string;
  filename: string;
  size: number;
  createdAt: number;
}

// Upload VTT content to Redis and return reference
export async function uploadVTT(
  content: string,
  filename: string,
  mimeType: string = 'text/vtt'
): Promise<VTTReference> {
  try {
    const response = await fetch('/api/session/vttStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, filename, mimeType }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to upload VTT');
    }

    const { vttId, sessionId } = await response.json();
    return { vttId, sessionId, filename, mimeType };
  } catch (error) {
    console.error('Error uploading VTT:', error);
    throw error;
  }
}

// Upload VTT file from File object
export async function uploadVTTFile(file: File): Promise<VTTReference> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const content = reader.result as string;
        const vttRef = await uploadVTT(content, file.name, file.type || 'text/vtt');
        resolve(vttRef);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read VTT file'));
    };

    reader.readAsText(file);
  });
}

// Get VTT content URL from reference
export function getVTTUrl(vttRef: VTTReference): string {
  return `/api/session/vttStorage?vttId=${vttRef.vttId}&sessionId=${vttRef.sessionId}`;
}

// Fetch VTT content from reference
export async function fetchVTTContent(vttRef: VTTReference): Promise<string> {
  const response = await fetch(getVTTUrl(vttRef));
  if (!response.ok) {
    throw new Error('Failed to fetch VTT content');
  }
  return response.text();
}

// List all VTT files for the current session
export async function listVTTFiles(): Promise<VTTListItem[]> {
  const response = await fetch('/api/session/vttStorage?list=true');
  if (!response.ok) {
    throw new Error('Failed to list VTT files');
  }
  const { vtts } = await response.json();
  return vtts;
}

// Delete a VTT file
export async function deleteVTT(vttId: string): Promise<boolean> {
  const response = await fetch(`/api/session/vttStorage?vttId=${vttId}`, {
    method: 'DELETE',
  });
  return response.ok;
}

// Check if a file is a VTT file
export function isVTTFile(file: File): boolean {
  const vttExtensions = ['.vtt', '.webvtt', '.srt'];
  const vttMimeTypes = ['text/vtt', 'text/plain', 'application/x-subrip'];

  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  const isVTTExtension = vttExtensions.includes(extension);
  const isVTTMimeType = vttMimeTypes.includes(file.type);

  return isVTTExtension || isVTTMimeType;
}

// Convert VTT reference to format expected by the backend tool
export function toVttRef(vttRef: VTTReference): { vttId: string; sessionId: string } {
  return {
    vttId: vttRef.vttId,
    sessionId: vttRef.sessionId,
  };
}
