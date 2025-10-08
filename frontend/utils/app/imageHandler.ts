import { Message } from '@/types/chat';
import { apiBase } from './api';

export interface ImageReference {
  imageId: string;
  sessionId: string;
  mimeType?: string;
}

export interface ProcessedMessage extends Message {
  attachments?: Array<{
    content: string;
    type: string;
    imageRef?: ImageReference;
  }>;
}

// Upload image to Redis and return reference
export async function uploadImage(base64Data: string, mimeType: string = 'image/jpeg'): Promise<ImageReference> {
  try {
    const response = await fetch('/api/session/imageStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Data, mimeType }),
    });

    if (!response.ok) {
      throw new Error('Failed to upload image');
    }

    const { imageId, sessionId } = await response.json();
    return { imageId, sessionId, mimeType };
  } catch (error) {
    console.error('Error uploading image:', error);
    throw error;
  }
}

// Get image URL from reference
export function getImageUrl(imageRef: ImageReference): string {
  return `/api/session/imageStorage?imageId=${imageRef.imageId}&sessionId=${imageRef.sessionId}`;
}

// Process message to replace base64 images with references
export async function processMessageImages(message: ProcessedMessage): Promise<ProcessedMessage> {
  if (!message.attachments || message.attachments.length === 0) {
    return message;
  }

  const processedAttachments = await Promise.all(
    message.attachments.map(async (attachment) => {
      if (attachment.type === 'image' && attachment.content) {
        try {
          // Check if it's already a reference
          if (attachment.imageRef) {
            return attachment;
          }

          // Upload image and get reference
          const imageRef = await uploadImage(attachment.content);

          // Return attachment with reference instead of base64
          return {
            ...attachment,
            content: '', // Clear the base64 content
            imageRef,
          };
        } catch (error) {
          console.error('Error processing image attachment:', error);
          // Return original attachment if processing fails
          return attachment;
        }
      }
      return attachment;
    })
  );

  return {
    ...message,
    attachments: processedAttachments,
  };
}

// Clean messages for LLM (remove image data, keep only references)
export function cleanMessagesForLLM(messages: any[]): Message[] {
  const cleaned = messages.map((message) => {
    // Create a clean copy without attachments first
    const cleanedMessage = {
      role: message.role,
      content: message.content || '',
      id: message.id,
      // Explicitly exclude attachments and any other fields that might contain base64
    };

    // If message has attachments, add text descriptions instead of raw data
    if (message.attachments && message.attachments.length > 0) {
      if (message.role === 'user') {
        const imageCount = message.attachments.filter((att: any) =>
          att.type === 'image' && (att.imageRef || att.content)
        ).length;

        if (imageCount > 0) {
          const imageText = imageCount === 1 ? '[Image attachment]' : `[${imageCount} image attachments]`;
          cleanedMessage.content = `${message.content}${message.content ? '\n' : ''}${imageText}`;
        }
      }
    }

    // Remove any properties that might contain base64 data
    const keysToRemove = ['attachments', 'inputFileContent', 'inputFileContentCompressed'];
    keysToRemove.forEach(key => {
      if (key in cleanedMessage) {
        delete (cleanedMessage as any)[key];
      }
    });

    return cleanedMessage;
  });

  // Log the cleaning operation for debugging
  console.log('cleanMessagesForLLM: Cleaned', messages.length, 'messages for LLM, removed attachments');

  return cleaned;
}

// Clean messages for storage (remove base64 content but keep image references for UI)
export function cleanMessagesForStorage(messages: any[]): any[] {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }

    // Clean attachments to remove base64 content but keep references
    const cleanedAttachments = message.attachments.map((attachment: any) => {
      if (attachment.type === 'image') {
        // If attachment has base64 content, remove it but keep the reference
        if (attachment.content && (
          attachment.content.startsWith('data:image/') ||
          attachment.content.length > 1000 // Any large content is likely base64
        )) {
          return {
            ...attachment,
            content: '', // Remove base64 to prevent storage bloat
          };
        }
      }
      return attachment;
    });

    // Also remove any other properties that might contain base64
    const cleanedMessage = { ...message };
    const keysToRemove = ['inputFileContent', 'inputFileContentCompressed'];
    keysToRemove.forEach(key => {
      if (key in cleanedMessage) {
        delete cleanedMessage[key];
      }
    });

    return {
      ...cleanedMessage,
      attachments: cleanedAttachments,
    };
  });
}

// Restore image references in messages (for loading from storage)
export function restoreMessageImages(messages: any[]): any[] {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }

    // Ensure all image attachments have proper references and no base64 content
    const restoredAttachments = message.attachments.map((attachment: any) => {
      if (attachment.type === 'image') {
        // Remove any base64 content that might have been stored
        if (attachment.content && (
          attachment.content.startsWith('data:image/') ||
          attachment.content.length > 1000
        )) {
          return {
            ...attachment,
            content: '', // Clear base64 content
          };
        }
        return attachment;
      }
      return attachment;
    });

    return {
      ...message,
      attachments: restoredAttachments,
    };
  });
}

// Aggressively remove any base64 content from objects (recursive)
export function stripBase64Content(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stripBase64Content(item));
  }

  const cleaned = { ...obj };

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      // Remove base64 image data
      if (value.startsWith('data:image/') || (value.length > 1000 && value.includes('base64'))) {
        cleaned[key] = '';
      }
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = stripBase64Content(value);
    }
  }

  return cleaned;
}

// Delete image from storage
export async function deleteImage(imageId: string): Promise<void> {
  try {
    const response = await fetch(`/api/session/imageStorage?imageId=${imageId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete image');
    }
  } catch (error) {
    console.error('Error deleting image:', error);
    throw error;
  }
}

// Process markdown content to extract and store base64 images, replacing them with references
export async function processMarkdownImages(content: string): Promise<string> {
  if (!content || typeof content !== 'string') {
    return content;
  }

  // Regex to match markdown images with base64 data
  const markdownImageRegex = /!\[([^\]]*)\]\((data:image\/[a-zA-Z]+;base64,[^\)]+)\)/g;

  let processedContent = content;
  const matches = Array.from(content.matchAll(markdownImageRegex));

  // Process each image sequentially to avoid race conditions
  for (const match of matches) {
    try {
      const fullMatch = match[0];
      const altText = match[1] || 'Generated image';
      const base64Data = match[2];

      // Extract mime type from data URL
      const mimeTypeMatch = base64Data.match(/data:(image\/[a-zA-Z]+);base64,/);
      const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/png';

      // Upload to Redis
      const imageRef = await uploadImage(base64Data, mimeType);

      // Create a reference URL that can be rendered
      const imageUrl = getImageUrl(imageRef);

      // Replace the base64 image with the reference URL
      const replacement = `![${altText}](${imageUrl})`;
      processedContent = processedContent.replace(fullMatch, replacement);

      console.log(`Processed markdown image: ${altText}, stored as ${imageRef.imageId}`);
    } catch (error) {
      console.error('Failed to process markdown image:', error);
      // Keep the original base64 image if processing fails
    }
  }

  return processedContent;
}
