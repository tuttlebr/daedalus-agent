import { NextApiRequest, NextApiResponse } from 'next';
import { getOrSetSessionId, getUserId } from '../session/_utils';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionId = getOrSetSessionId(req, res);
    const userId = await getUserId(req, res);
    const username = userId || 'anon';

    const { pdfRef, filename, collection } = req.body;

    if (!pdfRef || !pdfRef.pdfId || !pdfRef.sessionId) {
      return res.status(400).json({ error: 'Invalid PDF reference' });
    }

    // Use provided collection or default to username
    const targetCollection = collection || username;

    console.log('Processing PDF:', {
      pdfId: pdfRef.pdfId,
      sessionId: pdfRef.sessionId,
      username,
      collection: targetCollection
    });

    // Send a message to the chat endpoint that will trigger PDF processing
    const chatMessage = {
      messages: [{
        role: 'user',
        content: `Process the PDF "${filename || 'document'}" using nat_nv_ingest with pdfRef=${JSON.stringify(pdfRef)}, username="${username}", and collection_name="${targetCollection}".`
      }],
      additionalProps: {
        username: username,
        enableIntermediateSteps: false,
        isPDFProcessing: true  // Flag to indicate this is a PDF processing request
      }
    };

    const backendHost = process.env.BACKEND_HOST || 'daedalus-backend';
    const chatUrl = `http://${backendHost}-default.daedalus.svc.cluster.local:8000/chat`;

    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': username,
      },
      body: JSON.stringify(chatMessage),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to process PDF via chat:', errorText);
      return res.status(response.status).json({
        error: 'Failed to process PDF',
        details: errorText
      });
    }

    // Read the streaming response
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    if (reader) {
      let done = false;
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          fullResponse += decoder.decode(value, { stream: !done });
        }
      }
    }

    console.log('PDF processing response:', fullResponse);

    // Try to extract metadata from the response
    let metadata = {
      documentsIndexed: 0,
      extractedPages: 0
    };

    // Extract number of documents indexed
    const docsMatch = fullResponse.match(/(\d+)\s+documents?\s+indexed/i);
    if (docsMatch) {
      metadata.documentsIndexed = parseInt(docsMatch[1]);
    }

    // Extract number of pages
    const pagesMatch = fullResponse.match(/(\d+)\s+pages?/i);
    if (pagesMatch) {
      metadata.extractedPages = parseInt(pagesMatch[1]);
    }

    // Check if the response indicates success
    if (fullResponse.includes('Successfully processed PDF') || fullResponse.includes('indexed')) {
      return res.status(200).json({
        success: true,
        message: 'PDF processed successfully',
        details: fullResponse,
        metadata: {
          ...metadata,
          collection: targetCollection
        }
      });
    } else if (fullResponse.includes('Error') || fullResponse.includes('Failed')) {
      return res.status(400).json({
        error: 'PDF processing failed',
        details: fullResponse
      });
    }

    return res.status(200).json({
      success: true,
      message: 'PDF processing request sent',
      details: fullResponse,
      metadata: {
        ...metadata,
        collection: targetCollection
      }
    });

  } catch (error) {
    console.error('Error processing PDF:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
