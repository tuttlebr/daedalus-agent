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
    }
    catch (e) {
        console.log("error - sanitizing content", e);
        return content; // Return original if fixing fails
    }
};
