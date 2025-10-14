import { v4 as uuidv4 } from 'uuid';
import { getUserSessionItem, setUserSessionItem, removeUserSessionItem } from './storage';

export const getInitials = (fullName = '') => {
    if (!fullName) {
        return "";
    }
    const initials = fullName.split(' ').map(name => name[0]).join('').toUpperCase();
    return initials;
}
export const compressImage = (base64: string, mimeType: string | undefined, shouldCompress: boolean, callback: { (compressedBase64: string): void; (arg0: string): void; }) => {
    const MAX_SIZE = 200 * 1024; // 200 KB maximum size
    const MIN_SIZE = 100 * 1024;  // 100 KB minimum size, to avoid under compression
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    img.onload = () => {
        let width = img.width;
        let height = img.height;
        const maxSize = 800; // Start with a larger size for initial scaling

        if (width > maxSize || height > maxSize) {
            if (width > height) {
                height *= maxSize / width;
                width = maxSize;
            } else {
                width *= maxSize / height;
                height = maxSize;
            }
        }

        canvas.width = width;
        canvas.height = height;
        if (ctx) ctx.drawImage(img, 0, 0, width, height);

        let quality = 0.9;  // Start with high quality
        let newDataUrl = canvas.toDataURL(mimeType, quality);

        if (shouldCompress) {
            while (newDataUrl.length > MAX_SIZE && quality > 0.1) {
                quality -= 0.05; // Gradually reduce quality
                newDataUrl = canvas.toDataURL(mimeType, quality);
            }

            // Check if overly compressed, then adjust quality slightly back up
            while (newDataUrl.length < MIN_SIZE && quality <= 0.9) {
                quality += 0.05; // Increment quality slightly
                newDataUrl = canvas.toDataURL(mimeType, quality);
            }

            // Further dimension reduction if still too large
            while (newDataUrl.length > MAX_SIZE && (width > 50 || height > 50)) {
                width *= 0.75; // Reduce dimensions
                height *= 0.75;
                canvas.width = width;
                canvas.height = height;
                if (ctx) ctx.drawImage(img, 0, 0, width, height);
                newDataUrl = canvas.toDataURL(mimeType, quality);
            }
        }

        // console.log(`Original Base64 Size: ${base64.length / 1024} KB`);
        // console.log(`Compressed Base64 Size: ${newDataUrl.length / 1024} KB`);
        callback(newDataUrl);
    };

    img.src = base64;
}

export const getURLQueryParam = ({ param = '' }) => {
    // Get the URL query parameters safely
    const urlParams = new URLSearchParams(window?.location?.search);

    if (param) {
        // Get the value of a specific query parameter
        return urlParams.get(param);
    } else {
        // Get all query params safely
        const paramsObject = Object.create(null); // Prevent prototype pollution
        for (const [key, value] of Array.from(urlParams?.entries())) {
            if (Object.prototype.hasOwnProperty.call(paramsObject, key)) continue; // Extra safety check
            paramsObject[key] = value;
        }
        return paramsObject;
    }
};


export const getWorkflowName = () => {
    const workflow = getURLQueryParam({ param: 'workflow' }) || process?.env?.NEXT_PUBLIC_WORKFLOW || 'Daedalus';
    return workflow
}

export const setSessionError = (message = 'unknown error') => {
    // Use user-specific storage keys to prevent data leakage between users
    setUserSessionItem('error', 'true');
    setUserSessionItem('errorMessage', message);
}

export const removeSessionError = () => {
    // Use user-specific storage keys to prevent data leakage between users
    removeUserSessionItem('error');
    removeUserSessionItem('errorMessage');
}

export const isInsideIframe = () => {
    try {
        return window?.self !== window?.top;
    } catch (e) {
        // If a security error occurs (cross-origin), assume it's in an iframe
        return true;
    }
};

export const fetchLastMessage = ({ messages = [], role = 'user' }: { messages: any[]; role?: string }) => {
    // Loop from the end to find the last message with the role "user"
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === role) {
            return messages[i];  // Return the content of the last user message
        }
    }
    return null;  // Return null if no user message is found
}

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface IntermediateStep {
    id: string;
    parent_id?: string;
    index?: number;
    content?: any;
    intermediate_steps?: IntermediateStep[];
    [key: string]: any; // For any additional properties
}

export const processIntermediateMessage = (
    existingSteps: IntermediateStep[] = [],
    newMessage: IntermediateStep = {} as IntermediateStep,
    intermediateStepOverride = true
): IntermediateStep[] => {

    if (!newMessage.id) {
        console.log('Skipping message processing - no message ID provided');
        return existingSteps;
    }

    // Helper function to find and replace a message in the steps tree
    const replaceMessage = (steps: IntermediateStep[]): boolean => {
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].id === newMessage.id && steps[i].content?.name === newMessage.content?.name) {
                // Preserve the index when overriding
                steps[i] = {
                    ...newMessage,
                    index: steps[i].index
                };
                return true;
            }

            // Recursively check intermediate steps
            const intermediateSteps = steps[i].intermediate_steps;
            if (intermediateSteps && intermediateSteps.length > 0) {
                if (replaceMessage(intermediateSteps)) {
                    return true;
                }
            }
        }
        return false;
    };

    // Helper function to find a parent step by ID
    const findParentStep = (steps: IntermediateStep[], parentId: string): IntermediateStep | null => {
        for (const step of steps) {
            if (step.id === parentId) {
                return step;
            }
            const intermediateSteps = step.intermediate_steps;
            if (intermediateSteps && intermediateSteps.length > 0) {
                const found = findParentStep(intermediateSteps, parentId);
                if (found) return found;
            }
        }
        return null;
    };

    try {
        // If override is enabled and message exists, try to replace it
        if (intermediateStepOverride) {
            const wasReplaced = replaceMessage(existingSteps);
            if (wasReplaced) {
                return existingSteps;
            }
        }

        // If message wasn't replaced or override is disabled, add it to the appropriate place
        if (newMessage.parent_id) {
            const parentStep = findParentStep(existingSteps, newMessage.parent_id);
            if (parentStep) {
                // Initialize intermediate_steps array if it doesn't exist
                if (!parentStep.intermediate_steps) {
                    parentStep.intermediate_steps = [];
                }
                parentStep.intermediate_steps.push(newMessage);
                return existingSteps;
            }
        }

        // If no parent found or no parent_id, add to root level
        existingSteps.push(newMessage);
        return existingSteps;

    } catch (error) {
        console.log('Error in processIntermediateMessage:', {
            error,
            messageId: newMessage.id,
            parentId: newMessage.parent_id
        });
        return existingSteps;
    }
};

export const escapeHtml = (str: string): string => {
    try {
        if (typeof str !== 'string') {
            throw new TypeError('Input must be a string');
        }
        return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    } catch (error) {
        console.error('Error in escapeHtml:', error);
        return ''; // Return an empty string in case of error
    }
};

export const convertBackticksToPreCode = (markdown = '') => {
    try {
        if (typeof markdown !== 'string') {
            throw new TypeError('Input must be a string');
        }

        // Step 1: Convert code blocks first
        markdown = markdown.replace(
            /```(\w+)?\n([\s\S]*?)\n```/g,
            (_, lang, code) => {
                const languageClass = lang ? ` class="language-${lang}"` : '';
                const escapedCode = escapeHtml(code);
                return `\n<pre><code${languageClass}>${escapedCode}</code></pre>\n`;
            }
        );

        // Step 2: Convert bold text **bold**
        markdown = markdown.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        return markdown;
    } catch (error) {
        console.error('Error in convertBackticksToPreCode:', error);
        return markdown;
    }
};

// Truncate a string to a maximum length with ellipsis
const truncateString = (str: string, maxLength: number): string => {
    if (!str || str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '\n\n... [truncated for performance]';
};

// Configuration for intermediate steps limits
const INTERMEDIATE_STEPS_CONFIG = {
    MAX_PAYLOAD_LENGTH: 500, // Max characters per payload (reduced from 5000 to prevent UI overflow)
    MAX_NESTED_DEPTH: 2, // Max nesting depth to render (reduced from 3)
    MAX_STEPS_PER_MESSAGE: 20, // Max number of intermediate steps to keep (reduced from 50)
};

/**
 * Trim intermediate steps to prevent memory bloat
 * Keeps only the most recent steps up to the configured limit
 */
export const trimIntermediateSteps = (steps: IntermediateStep[] = []): IntermediateStep[] => {
    if (!Array.isArray(steps)) return [];

    const maxSteps = INTERMEDIATE_STEPS_CONFIG.MAX_STEPS_PER_MESSAGE;

    // Filter out steps with very large payloads or system prompts
    const shouldFilterStep = (step: IntermediateStep): boolean => {
        if (!step?.content?.payload) return false;

        const payload = typeof step.content.payload === 'string'
            ? step.content.payload
            : JSON.stringify(step.content.payload);

        // Filter out system prompts and extremely large payloads
        const verbosePatterns = [
            'Answer the following questions as best you can',
            'You are an expert',
            'System:',
            'SystemMessage(',
            'FieldInfo(annotation=',
            'Arguments must be provided as a valid JSON object'
        ];

        // If payload is extremely large (>10000 chars) or contains verbose patterns, filter it out
        if (payload.length > 10000 || verbosePatterns.some(pattern => payload.includes(pattern))) {
            console.log('Filtering out verbose intermediate step:', step.content?.name || 'unknown', 'payload length:', payload.length);
            return true;
        }

        return false;
    };

    // Filter out verbose steps
    const filteredSteps = steps.filter(step => !shouldFilterStep(step));

    // If we're under the limit after filtering, return as-is
    if (filteredSteps.length <= maxSteps) {
        return filteredSteps;
    }

    // Keep only the most recent steps
    // We slice from the end to keep the latest intermediate steps
    const trimmedSteps = filteredSteps.slice(-maxSteps);

    console.log(`Trimmed intermediate steps from ${steps.length} to ${trimmedSteps.length} (filtered: ${steps.length - filteredSteps.length}) for performance`);

    return trimmedSteps;
};

export const generateContentIntermediate = (intermediateSteps: IntermediateStep[] = []): string => {
    const generateDetails = (data: IntermediateStep[], depth = 0): string => {
        try {
            if (!Array.isArray(data)) {
                throw new TypeError('Input must be an array');
            }

            // Stop rendering if we've reached max depth
            if (depth >= INTERMEDIATE_STEPS_CONFIG.MAX_NESTED_DEPTH) {
                return '';
            }

            return data.map((item) => {
                const currentId = item.id;
                const currentIndex = item.index;

                // Get raw payload
                const rawPayload = item.content?.payload || '';
                const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

                // Additional filtering: skip extremely verbose steps that shouldn't be displayed
                const verbosePatterns = [
                    'Answer the following questions as best you can',
                    'SystemMessage(',
                    'FieldInfo(annotation=',
                    'Arguments must be provided as a valid JSON object'
                ];

                if (payloadStr.length > 10000 || verbosePatterns.some(pattern => payloadStr.includes(pattern))) {
                    console.log('Skipping verbose intermediate step in rendering:', item.content?.name || 'unknown');
                    return ''; // Skip this step entirely
                }

                // Truncate payload to prevent memory bloat
                const truncatedPayload = truncateString(payloadStr, INTERMEDIATE_STEPS_CONFIG.MAX_PAYLOAD_LENGTH);
                const sanitizedPayload = convertBackticksToPreCode(truncatedPayload);

                let details = `<details id=${currentId} index=${currentIndex}>\n`;
                details += `  <summary id=${currentId}>${item.content?.name || ''}</summary>\n`;

                details += `\n${sanitizedPayload}\n`;

                if (item.intermediate_steps && item.intermediate_steps.length > 0) {
                    details += generateDetails(item.intermediate_steps, depth + 1);
                }

                details += `</details>\n`;
                return details;
            }).filter(d => d).join(''); // Filter out empty strings
        } catch (error) {
            console.error('error in generateDetails:', error);
            return ''; // Return an empty string in case of error
        }
    };

    try {
        if (!Array.isArray(intermediateSteps) || intermediateSteps.length === 0) {
            return '';
        }
        let intermediateContent = generateDetails(intermediateSteps, 0);
        const firstStep = intermediateSteps[0];
        if (firstStep && firstStep.parent_id) {
            intermediateContent = `<details id=${uuidv4()} index="-1" ><summary id=${firstStep.parent_id}>References</summary>\n${intermediateContent}</details>`;
        }
        if (/(?:\\)?```/.test(intermediateContent)) {
            intermediateContent = intermediateContent.replace(/\n{2,}/g, '\n');
        }
        return intermediateContent;
    } catch (error) {
        console.error('error in generateIntermediateMarkdown:', error);
        return '';
    }
};

export const replaceMalformedMarkdownImages = (str = '') => {
    return str.replace(/!\[.*?\]\(([^)]*)$/, (match) => {
        return `<img src="loading" alt="loading" style="max-width: 100%; height: 100%;" />`;
    });
}

export const replaceMalformedHTMLImages = (str = '') => {
    return str.replace(/<img\s+[^>]*$/, (match) => {
        return `<img src="loading" alt="loading" style="max-width: 100%; height: 100%;" />`;
    });
}

export const replaceMalformedHTMLVideos = (str = '') => {
    return str.replace(/<video\s+[^>]*$/, (match) => {
        return `<video controls width="400" height="200">
            <source src="loading" type="video/mp4">
            Your browser does not support the video tag.
        </video>`;
    });
}


export const fixMalformedHtml = (content = '') => {
    try {

        let fixed = replaceMalformedHTMLImages(content);
        fixed = replaceMalformedHTMLVideos(fixed);
        fixed = replaceMalformedMarkdownImages(fixed);
        return fixed;

        // Sanitize content
        // let sanitizedContent = DOMPurify.sanitize(content);

        // // Fallback for empty or fully stripped content
        // if (!sanitizedContent) {
        //   return sanitizedContent = `<img src="loading" alt="loading" style="max-width: 100%; height: 100%;"/>`;
        // }

        // const fixed = replaceMalformedMarkdownImages(sanitizedContent);
        // return fixed;

        // let dirtyHtml = marked(content);
        // // remove <p> and </p> tags to reveal malformed img or other html tags
        // dirtyHtml = dirtyHtml.replace(/<p>/g, "\n");
        // dirtyHtml = dirtyHtml.replace(/<\/p>/g, "");
        // console.log(dirtyHtml);
        // const cleanHtml = DOMPurify.sanitize(dirtyHtml);
        // if(!cleanHtml) {
        //   return `<img src="loading" alt="loading" style="max-width: 100%; height: 100%;"/>`
        // }
        // return sanitizedContent;
    }
    catch (e) {
        console.log("error - sanitizing content", e);
        return content; // Return original if fixing fails
    }
};
