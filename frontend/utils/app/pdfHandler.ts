export interface PDFReference {
  pdfId: string;
  sessionId: string;
  filename?: string;
  mimeType?: string;
}

// Upload PDF to Redis and return reference
export async function uploadPDF(
  base64Data: string,
  filename: string,
  mimeType: string = 'application/pdf'
): Promise<PDFReference> {
  try {
    const response = await fetch('/api/session/pdfStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Data, filename, mimeType }),
    });

    if (!response.ok) {
      throw new Error('Failed to upload PDF');
    }

    const { pdfId, sessionId } = await response.json();
    return { pdfId, sessionId, filename, mimeType };
  } catch (error) {
    console.error('Error uploading PDF:', error);
    throw error;
  }
}

// Get PDF URL from reference
export function getPDFUrl(pdfRef: PDFReference): string {
  return `/api/session/pdfStorage?pdfId=${pdfRef.pdfId}&sessionId=${pdfRef.sessionId}`;
}
