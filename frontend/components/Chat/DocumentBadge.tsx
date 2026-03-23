import React, { FC } from 'react';
import { IconPaperclip, IconFileTypePdf, IconFileTypeDocx, IconFileTypePpt, IconFileCode } from '@tabler/icons-react';
import { formatFileSize } from '@/constants/uploadLimits';

interface DocumentBadgeProps {
  filename: string;
  mimeType?: string;
  size?: number;
}

const getDocIcon = (filename: string, mimeType?: string) => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
    return <IconFileTypePdf size={16} className="text-red-500" />;
  }
  if (lower.endsWith('.docx') || lower.endsWith('.doc') || mimeType?.includes('word')) {
    return <IconFileTypeDocx size={16} className="text-blue-500" />;
  }
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt') || mimeType?.includes('presentation')) {
    return <IconFileTypePpt size={16} className="text-orange-500" />;
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm') || mimeType?.includes('html')) {
    return <IconFileCode size={16} className="text-gray-500" />;
  }
  return <IconPaperclip size={16} className="text-gray-500 dark:text-gray-400" />;
};

export const DocumentBadge: FC<DocumentBadgeProps> = ({ filename, mimeType, size }) => {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-2 border border-gray-200 dark:border-gray-700">
      {getDocIcon(filename, mimeType)}
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300 max-w-[200px] truncate">
        {filename}
      </span>
      {size != null && size > 0 && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {formatFileSize(size)}
        </span>
      )}
    </div>
  );
};
