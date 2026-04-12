'use client';

import React, { memo, useState } from 'react';
import classNames from 'classnames';
import {
  IconMessage, IconPaperclip, IconCamera, IconWorldSearch,
  IconPhoto, IconPencil, IconDatabase, IconRss, IconNotes,
  IconFileText, IconMessages, IconSearch, IconEye, IconSettings,
  IconFileExport, IconKeyboard, IconDownload,
} from '@tabler/icons-react';
import { Dialog } from '@/components/primitives';

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

const HELP_SECTIONS = [
  { icon: IconMessage, title: 'Chatting', content: 'Type your message and press Enter to send. Use Shift+Enter for new lines. The AI agent will process your request using its available tools.' },
  { icon: IconPaperclip, title: 'Attaching Files', content: 'Click the paperclip icon or drag files onto the chat. Supports images (PNG, JPG, GIF, WebP), documents (PDF, DOCX, PPTX, HTML), and videos (MP4, FLV, 3GP). Files are securely stored and processed.' },
  { icon: IconCamera, title: 'Taking Photos', content: 'Use the camera button on mobile to capture and send photos directly. Grant camera permission when prompted.' },
  { icon: IconWorldSearch, title: 'Web Search and Browsing', content: 'Ask the agent to search the web for current information. It can also browse specific URLs and extract content from web pages.' },
  { icon: IconPhoto, title: 'Image Generation', content: 'Ask the agent to generate images from text descriptions. Supports iterative editing - ask to modify generated images.' },
  { icon: IconPencil, title: 'Image Editing', content: 'Upload an image and ask the agent to edit, enhance, or transform it. Describe the changes you want.' },
  { icon: IconDatabase, title: 'Knowledge Bases', content: 'Upload documents to create searchable knowledge bases using Milvus vector storage. The agent can then search these for relevant information.' },
  { icon: IconRss, title: 'News and RSS Feeds', content: 'Ask about the latest news or blog posts. The agent can access NVIDIA blogs, tech news, and configured RSS feeds.' },
  { icon: IconNotes, title: 'Meeting Notes from Transcripts', content: 'Upload meeting transcripts (VTT format) and ask the agent to create structured meeting notes with action items.' },
  { icon: IconFileText, title: 'Document Q&A', content: 'Upload PDFs, DOCX, or other documents and ask questions about their content. The agent extracts and indexes the text for search.' },
  { icon: IconMessages, title: 'Managing Conversations', content: 'Create new conversations with the + button. Rename by clicking the title. Delete with the X icon on hover. Organize into folders.' },
  { icon: IconSearch, title: 'Searching Conversations', content: 'Use the search bar in the sidebar to filter conversations by name. Type to filter in real-time.' },
  { icon: IconEye, title: 'Viewing AI Reasoning', content: 'Toggle "Show Agent Steps" in Settings to see the agent\'s reasoning process - which tools it calls, what it finds, and how it formulates answers.' },
  { icon: IconSettings, title: 'Settings', content: 'Access Settings from the sidebar. Configure theme, agent steps visibility, background processing, and energy saving mode.' },
  { icon: IconFileExport, title: 'Export and Import', content: 'Export all conversations as JSON for backup. Import from a JSON file to restore or merge conversations.' },
  { icon: IconKeyboard, title: 'Keyboard Shortcuts', content: 'Enter: Send message | Shift+Enter: New line | Ctrl+N: New conversation | Ctrl+B: Toggle sidebar | Escape: Close dialogs' },
  { icon: IconDownload, title: 'Install as App (PWA)', content: 'Install Daedalus as a progressive web app for the best experience. On Chrome, click the install prompt or use the browser menu.' },
];

export const HelpDialog = memo(({ open, onClose }: HelpDialogProps) => {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <Dialog open={open} onClose={onClose} title="Help" size="lg">
      <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-2">
        {HELP_SECTIONS.map(({ icon: Icon, title, content }, i) => (
          <div key={title} className="border-b border-white/[0.04] last:border-0">
            <button
              onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
              className="flex items-center gap-3 w-full py-3 px-2 text-left hover:bg-white/[0.02] rounded-lg transition-colors"
            >
              <Icon size={18} className="text-nvidia-green flex-shrink-0" />
              <span className="text-sm font-medium text-dark-text-primary flex-1">{title}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={classNames(
                  'text-dark-text-muted transition-transform duration-200',
                  expandedIndex === i && 'rotate-180'
                )}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {expandedIndex === i && (
              <div className="px-2 pb-3 pl-10 text-sm text-dark-text-secondary animate-morph-in">
                {content}
              </div>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  );
});

HelpDialog.displayName = 'HelpDialog';
