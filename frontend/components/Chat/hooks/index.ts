/**
 * Chat component hooks
 *
 * These hooks extract common logic from the Chat and ChatInput components
 * for better maintainability and reusability.
 */

// Chat scroll management
export { useChatScroll } from './useChatScroll';
export { default as useChatScrollDefault } from './useChatScroll';

// Device orientation and type detection
export { useOrientation } from './useOrientation';
export { default as useOrientationDefault } from './useOrientation';

// Message actions (copy, edit, delete, regenerate)
export { useMessageActions } from './useMessageActions';
export { default as useMessageActionsDefault } from './useMessageActions';

// File upload tracking and management
export { useFileUpload } from './useFileUpload';
export { default as useFileUploadDefault } from './useFileUpload';

// Textarea auto-resize
export { useTextareaResize } from './useTextareaResize';
export { default as useTextareaResizeDefault } from './useTextareaResize';
