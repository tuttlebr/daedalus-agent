/**
 * Tests for the DocumentBadge component (components/Chat/DocumentBadge.tsx).
 *
 * Since @testing-library/react is not installed we render using react-dom/server
 * (renderToStaticMarkup) which is available with the existing React 18 dependency.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ---- Mock tabler icons ----
vi.mock('@tabler/icons-react', () => ({
  IconPaperclip: (props: any) => React.createElement('svg', { 'data-testid': 'icon-paperclip', ...props }),
  IconFileTypePdf: (props: any) => React.createElement('svg', { 'data-testid': 'icon-pdf', ...props }),
  IconFileTypeDocx: (props: any) => React.createElement('svg', { 'data-testid': 'icon-docx', ...props }),
  IconFileTypePpt: (props: any) => React.createElement('svg', { 'data-testid': 'icon-ppt', ...props }),
  IconFileCode: (props: any) => React.createElement('svg', { 'data-testid': 'icon-code', ...props }),
}));

// ---- Mock formatFileSize ----
vi.mock('@/constants/uploadLimits', () => ({
  formatFileSize: vi.fn((bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }),
}));

import { DocumentBadge } from '@/components/Chat/DocumentBadge';

describe('DocumentBadge', () => {
  // ---------- Filename rendering ----------

  describe('filename rendering', () => {
    it('renders the filename text', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'report.pdf' }),
      );
      expect(html).toContain('report.pdf');
    });

    it('renders a long filename', () => {
      const longName = 'a-very-long-document-name-that-might-be-truncated.pdf';
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: longName }),
      );
      expect(html).toContain(longName);
    });
  });

  // ---------- Icon selection ----------

  describe('icon selection', () => {
    it('shows PDF icon for .pdf files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'report.pdf' }),
      );
      expect(html).toContain('data-testid="icon-pdf"');
    });

    it('shows PDF icon when mimeType is application/pdf', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'document', mimeType: 'application/pdf' }),
      );
      expect(html).toContain('data-testid="icon-pdf"');
    });

    it('shows DOCX icon for .docx files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'letter.docx' }),
      );
      expect(html).toContain('data-testid="icon-docx"');
    });

    it('shows DOCX icon for .doc files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'old-format.doc' }),
      );
      expect(html).toContain('data-testid="icon-docx"');
    });

    it('shows DOCX icon when mimeType includes "word"', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, {
          filename: 'file',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );
      expect(html).toContain('data-testid="icon-docx"');
    });

    it('shows PPT icon for .pptx files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'slides.pptx' }),
      );
      expect(html).toContain('data-testid="icon-ppt"');
    });

    it('shows PPT icon for .ppt files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'deck.ppt' }),
      );
      expect(html).toContain('data-testid="icon-ppt"');
    });

    it('shows PPT icon when mimeType includes "presentation"', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, {
          filename: 'file',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      );
      expect(html).toContain('data-testid="icon-ppt"');
    });

    it('shows code icon for .html files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'page.html' }),
      );
      expect(html).toContain('data-testid="icon-code"');
    });

    it('shows code icon for .htm files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'page.htm' }),
      );
      expect(html).toContain('data-testid="icon-code"');
    });

    it('shows code icon when mimeType includes "html"', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'file', mimeType: 'text/html' }),
      );
      expect(html).toContain('data-testid="icon-code"');
    });

    it('shows paperclip icon for unknown file types', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'data.csv' }),
      );
      expect(html).toContain('data-testid="icon-paperclip"');
    });

    it('shows paperclip icon for files with no extension', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'README' }),
      );
      expect(html).toContain('data-testid="icon-paperclip"');
    });

    it('is case-insensitive for extension matching', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'REPORT.PDF' }),
      );
      expect(html).toContain('data-testid="icon-pdf"');
    });
  });

  // ---------- File size display ----------

  describe('file size display', () => {
    it('shows formatted file size when size is provided', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'report.pdf', size: 1536 }),
      );
      expect(html).toContain('1.5 KB');
    });

    it('does not show file size when size is not provided', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'report.pdf' }),
      );
      // The size span should not be present
      expect(html).not.toContain('KB');
      expect(html).not.toContain('MB');
      expect(html).not.toContain(' B');
    });

    it('does not show file size when size is 0', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'report.pdf', size: 0 }),
      );
      expect(html).not.toContain('0 B');
    });

    it('shows MB for large files', () => {
      const size = 5 * 1024 * 1024; // 5MB
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'video.zip', size }),
      );
      expect(html).toContain('5.0 MB');
    });

    it('shows bytes for very small files', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'tiny.txt', size: 42 }),
      );
      expect(html).toContain('42 B');
    });
  });

  // ---------- CSS structure ----------

  describe('structure', () => {
    it('renders a containing div with expected classes', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'test.pdf' }),
      );
      expect(html).toContain('inline-flex');
      expect(html).toContain('items-center');
      expect(html).toContain('rounded-lg');
    });

    it('includes the truncate class for long filenames', () => {
      const html = renderToStaticMarkup(
        React.createElement(DocumentBadge, { filename: 'test.pdf' }),
      );
      expect(html).toContain('truncate');
    });
  });
});
