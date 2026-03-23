/**
 * Tests for the UploadProgressBar component (components/Chat/UploadProgressBar.tsx).
 *
 * Renders using react-dom/server since @testing-library/react is not installed.
 * For interactive tests (click handlers) we use react-dom/client with jsdom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ---- Mock tabler icons ----
vi.mock('@tabler/icons-react', () => ({
  IconX: (props: any) => React.createElement('svg', { 'data-testid': 'icon-x', ...props }),
  IconPhoto: (props: any) => React.createElement('svg', { 'data-testid': 'icon-photo', ...props }),
  IconVideo: (props: any) => React.createElement('svg', { 'data-testid': 'icon-video', ...props }),
  IconFile: (props: any) => React.createElement('svg', { 'data-testid': 'icon-file', ...props }),
}));

import { UploadProgressBar, UploadItem } from '@/components/Chat/UploadProgressBar';

describe('UploadProgressBar', () => {
  // ---------- Empty state ----------

  describe('empty state', () => {
    it('returns null when uploads is an empty object', () => {
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads: {}, onCancel: vi.fn() }),
      );
      expect(html).toBe('');
    });
  });

  // ---------- Upload count and average progress ----------

  describe('upload count and average progress', () => {
    it('shows "1 file" for a single upload', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('Uploading 1 file');
      // Should not have plural 's'
      expect(html).not.toContain('files');
    });

    it('shows "2 files" for multiple uploads', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 50, type: 'image' },
        'u-2': { filename: 'doc.pdf', progress: 80, type: 'document' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('Uploading 2 files');
    });

    it('shows correct average progress for single upload', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 75, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('75%');
    });

    it('shows correct average progress for multiple uploads', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'a.jpg', progress: 40, type: 'image' },
        'u-2': { filename: 'b.pdf', progress: 80, type: 'document' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      // Average of 40 and 80 = 60
      expect(html).toContain('60%');
    });

    it('rounds average progress to the nearest integer', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'a.jpg', progress: 33, type: 'image' },
        'u-2': { filename: 'b.pdf', progress: 67, type: 'document' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      // Average of 33 and 67 = 50
      expect(html).toContain('50%');
    });

    it('handles 0% progress', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 0, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('0%');
    });

    it('handles 100% progress', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 100, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('100%');
    });
  });

  // ---------- Individual upload chips ----------

  describe('individual upload chips', () => {
    it('renders a chip for each upload', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'alpha.jpg', progress: 10, type: 'image' },
        'u-2': { filename: 'beta.mp4', progress: 50, type: 'video' },
        'u-3': { filename: 'gamma.pdf', progress: 90, type: 'document' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('alpha.jpg');
      expect(html).toContain('beta.mp4');
      expect(html).toContain('gamma.pdf');
    });

    it('shows the correct icon for image uploads', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('data-testid="icon-photo"');
    });

    it('shows the correct icon for video uploads', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'clip.mp4', progress: 50, type: 'video' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('data-testid="icon-video"');
    });

    it('shows the correct icon for document uploads', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'report.pdf', progress: 50, type: 'document' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('data-testid="icon-file"');
    });

    it('renders a progress bar for each upload', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 65, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      // The progress bar inner div should have width set as inline style
      expect(html).toContain('width:65%');
    });

    it('renders cancel button with correct aria-label', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('aria-label="Cancel upload of photo.jpg"');
    });

    it('renders cancel button X icon', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'photo.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('data-testid="icon-x"');
    });
  });

  // ---------- Cancel button interaction ----------

  describe('cancel button interaction', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      document.body.removeChild(container);
    });

    it('calls onCancel with the correct upload id when cancel is clicked', async () => {
      // Use dynamic import of createRoot for client-side rendering
      const { createRoot } = await import('react-dom/client');
      const onCancel = vi.fn();
      const uploads: Record<string, UploadItem> = {
        'upload-abc': { filename: 'photo.jpg', progress: 50, type: 'image' },
      };

      const root = createRoot(container);
      await new Promise<void>((resolve) => {
        root.render(
          React.createElement(UploadProgressBar, { uploads, onCancel }),
        );
        // Allow React to flush
        setTimeout(resolve, 0);
      });

      const cancelButton = container.querySelector('button[aria-label="Cancel upload of photo.jpg"]');
      expect(cancelButton).not.toBeNull();

      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onCancel).toHaveBeenCalledWith('upload-abc');

      root.unmount();
    });

    it('calls onCancel with the correct id for each upload', async () => {
      const { createRoot } = await import('react-dom/client');
      const onCancel = vi.fn();
      const uploads: Record<string, UploadItem> = {
        'id-1': { filename: 'alpha.jpg', progress: 20, type: 'image' },
        'id-2': { filename: 'beta.pdf', progress: 80, type: 'document' },
      };

      const root = createRoot(container);
      await new Promise<void>((resolve) => {
        root.render(
          React.createElement(UploadProgressBar, { uploads, onCancel }),
        );
        setTimeout(resolve, 0);
      });

      // Click the second cancel button
      const cancelButtons = container.querySelectorAll('button[aria-label^="Cancel upload of"]');
      expect(cancelButtons).toHaveLength(2);

      // Click cancel for beta.pdf
      const betaButton = container.querySelector('button[aria-label="Cancel upload of beta.pdf"]');
      expect(betaButton).not.toBeNull();
      betaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onCancel).toHaveBeenCalledWith('id-2');

      root.unmount();
    });
  });

  // ---------- CSS structure ----------

  describe('structure', () => {
    it('renders a top-level container with expected classes', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'a.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('flex flex-col');
      expect(html).toContain('border-t');
    });

    it('renders progress bar track with overflow-hidden', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'a.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('overflow-hidden');
    });

    it('renders chips with rounded-full styling', () => {
      const uploads: Record<string, UploadItem> = {
        'u-1': { filename: 'a.jpg', progress: 50, type: 'image' },
      };
      const html = renderToStaticMarkup(
        React.createElement(UploadProgressBar, { uploads, onCancel: vi.fn() }),
      );
      expect(html).toContain('rounded-full');
    });
  });
});
