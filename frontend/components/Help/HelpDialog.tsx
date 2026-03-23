import { FC, useEffect, useRef, useState } from 'react';
import {
  IconX,
  IconBrain,
  IconPaperclip,
  IconCamera,
  IconMessage,
  IconFolder,
  IconSearch,
  IconSettings,
  IconFileExport,
  IconEye,
  IconDatabase,
  IconPhoto,
  IconPhotoEdit,
  IconWorld,
  IconRss,
  IconNotes,
  IconFileUpload,
  IconChevronDown,
  IconDeviceDesktop,
  IconKeyboard,
} from '@tabler/icons-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

const HelpSection: FC<SectionProps> = ({ icon, title, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-white/5 transition-colors"
      >
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-nvidia-green/15 flex items-center justify-center text-nvidia-green">
          {icon}
        </div>
        <span className="flex-1 text-sm font-medium text-white">{title}</span>
        <IconChevronDown
          size={16}
          className={`text-white/40 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {isOpen && (
        <div className="px-4 pb-4 pt-1 text-sm text-white/70 leading-relaxed space-y-2">
          {children}
        </div>
      )}
    </div>
  );
};

export const HelpDialog: FC<Props> = ({ open, onClose }) => {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (open) {
      window.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div
        ref={modalRef}
        className="w-full sm:max-w-xl max-h-[90vh] sm:max-h-[85vh] liquid-glass-overlay rounded-t-3xl sm:rounded-2xl overflow-hidden animate-morph-in flex flex-col"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-white/10 flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">How to Use Daedalus</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/10 transition-colors"
            aria-label="Close help"
          >
            <IconX size={20} className="text-white/60" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
          <p className="text-sm text-white/60 pb-1">
            Daedalus is an AI assistant with access to web search, image tools, document analysis, knowledge bases, and more. Here&apos;s how to get the most out of it.
          </p>

          {/* Chatting */}
          <HelpSection icon={<IconMessage size={18} />} title="Chatting" defaultOpen={true}>
            <p>Type your message in the input box at the bottom and press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 text-xs font-mono">Enter</kbd> or tap the send button. The AI streams its response in real time.</p>
            <p>To insert a new line without sending, press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 text-xs font-mono">Shift + Enter</kbd>.</p>
            <p>Click the <strong className="text-white/90">stop</strong> button while a response is streaming to cancel it.</p>
          </HelpSection>

          {/* Deep Thinker */}
          <HelpSection icon={<IconBrain size={18} />} title="Deep Thinker Mode">
            <p>Toggle the <strong className="text-nvidia-green">Deep Thinker</strong> button below the input to switch between two AI modes:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li><strong className="text-white/90">Standard</strong> &mdash; fast responses for everyday questions, quick lookups, and simple tasks.</li>
              <li><strong className="text-nvidia-green">Deep Thinker</strong> &mdash; a reasoning agent that methodically researches your question, chains multiple tools together, and delivers comprehensive answers. Best for complex research, multi-step analysis, and questions that benefit from deeper thinking. Responses take longer but are more thorough.</li>
            </ul>
          </HelpSection>

          {/* Attachments */}
          <HelpSection icon={<IconPaperclip size={18} />} title="Attaching Files">
            <p>Tap the <strong className="text-white/90">paperclip</strong> icon to attach files to your message:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li><strong className="text-white/90">Images</strong> (PNG, JPG, GIF, WebP) &mdash; the AI can analyze, describe, and extract text from images.</li>
              <li><strong className="text-white/90">Documents</strong> (PDF, DOCX, TXT, etc.) &mdash; uploaded to a vector knowledge base so you can ask questions about their content.</li>
              <li><strong className="text-white/90">Videos</strong> (MP4, WebM, MOV) &mdash; the AI can analyze video frames and process transcripts.</li>
            </ul>
            <p>When uploading documents, you can choose which <strong className="text-white/90">collection</strong> to store them in using the collection selector that appears. Collections let you organize different sets of documents separately.</p>
          </HelpSection>

          {/* Camera */}
          <HelpSection icon={<IconCamera size={18} />} title="Taking Photos">
            <p>Tap the <strong className="text-white/90">camera</strong> icon to capture a photo directly from your device&apos;s camera and send it for analysis. Useful for quick OCR, identifying objects, or getting help with something in front of you.</p>
          </HelpSection>

          {/* What the AI can do */}
          <HelpSection icon={<IconWorld size={18} />} title="Web Search & Browsing">
            <p>The AI can search the web and read web pages for you. Just ask naturally:</p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-white/60 italic">
              <li>&ldquo;Search for the latest NVIDIA earnings report&rdquo;</li>
              <li>&ldquo;What does this page say?&rdquo; (and paste a URL)</li>
            </ul>
            <p>It will fetch content, summarize it, and cite sources.</p>
          </HelpSection>

          <HelpSection icon={<IconPhoto size={18} />} title="Image Generation">
            <p>Ask the AI to create images from text descriptions:</p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-white/60 italic">
              <li>&ldquo;Generate an image of a futuristic city at sunset&rdquo;</li>
              <li>&ldquo;Create a logo for a coffee shop called Brewtiful&rdquo;</li>
            </ul>
            <p>Generated images appear inline in the conversation and are stored for 7 days.</p>
          </HelpSection>

          <HelpSection icon={<IconPhotoEdit size={18} />} title="Image Editing">
            <p>Upload an image and ask the AI to modify it:</p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-white/60 italic">
              <li>&ldquo;Change the background to a beach&rdquo;</li>
              <li>&ldquo;Make this photo look like a watercolor painting&rdquo;</li>
            </ul>
          </HelpSection>

          <HelpSection icon={<IconDatabase size={18} />} title="Knowledge Bases">
            <p>The AI has access to several built-in knowledge bases it can search for accurate, sourced answers:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li><strong className="text-white/90">NVIDIA</strong> &mdash; GPU, CUDA, TensorRT, and DGX documentation</li>
              <li><strong className="text-white/90">Kubernetes</strong> &mdash; cluster management, configuration, and best practices</li>
              <li><strong className="text-white/90">Your uploads</strong> &mdash; any documents you&apos;ve uploaded are searchable too</li>
            </ul>
            <p>The AI automatically picks the right knowledge base based on your question.</p>
          </HelpSection>

          <HelpSection icon={<IconRss size={18} />} title="News & RSS Feeds">
            <p>Ask about recent news and the AI will search RSS feeds for relevant articles:</p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-white/60 italic">
              <li>&ldquo;What&apos;s the latest from the NVIDIA blog?&rdquo;</li>
              <li>&ldquo;Any recent news about GPU computing?&rdquo;</li>
            </ul>
          </HelpSection>

          <HelpSection icon={<IconNotes size={18} />} title="Meeting Notes from Transcripts">
            <p>Upload a VTT or SRT transcript file, and the AI will convert it into structured meeting notes with attendees, key updates, and action items.</p>
          </HelpSection>

          <HelpSection icon={<IconFileUpload size={18} />} title="Document Q&A">
            <p>Upload documents (PDF, Word, text files) and then ask questions about them. The AI ingests documents into a searchable knowledge base, so you can have a conversation about your files:</p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-white/60 italic">
              <li>&ldquo;Summarize this document&rdquo;</li>
              <li>&ldquo;What does section 3 say about pricing?&rdquo;</li>
              <li>&ldquo;Compare these two documents&rdquo;</li>
            </ul>
          </HelpSection>

          {/* Conversations */}
          <HelpSection icon={<IconFolder size={18} />} title="Managing Conversations">
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>Click <strong className="text-white/90">New Chat</strong> in the sidebar to start a fresh conversation.</li>
              <li><strong className="text-white/90">Rename</strong> a conversation by clicking its name in the sidebar.</li>
              <li>Drag conversations into <strong className="text-white/90">folders</strong> to organize them. Create folders with the folder icon.</li>
              <li>Use the <strong className="text-white/90">search bar</strong> at the top of the sidebar to find conversations by name or content.</li>
              <li><strong className="text-white/90">Delete</strong> a conversation using the trash icon that appears on hover.</li>
            </ul>
          </HelpSection>

          {/* Search */}
          <HelpSection icon={<IconSearch size={18} />} title="Searching Conversations">
            <p>Use the search bar at the top of the sidebar to filter conversations by name or message content. The search updates as you type.</p>
          </HelpSection>

          {/* Intermediate Steps */}
          <HelpSection icon={<IconEye size={18} />} title="Viewing AI Reasoning">
            <p>Enable <strong className="text-white/90">Intermediate Steps</strong> in Settings to see how the AI thinks through your question &mdash; what tools it calls, what data it retrieves, and how it builds its answer.</p>
            <p>Steps can be viewed as a <strong className="text-white/90">timeline</strong> or grouped by <strong className="text-white/90">category</strong>. You can search and expand individual steps for full details.</p>
          </HelpSection>

          {/* Settings */}
          <HelpSection icon={<IconSettings size={18} />} title="Settings">
            <p>Open <strong className="text-white/90">Settings</strong> from the sidebar to configure:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li><strong className="text-white/90">Theme</strong> &mdash; switch between dark and light mode.</li>
              <li><strong className="text-white/90">Chat History</strong> &mdash; toggle whether full conversation context is sent with each message (improves follow-up accuracy).</li>
              <li><strong className="text-white/90">Background Processing</strong> &mdash; when installed as a PWA, keeps processing even when your screen is locked.</li>
              <li><strong className="text-white/90">Intermediate Steps</strong> &mdash; show or hide the AI&apos;s reasoning and tool-call details.</li>
            </ul>
          </HelpSection>

          {/* Export/Import */}
          <HelpSection icon={<IconFileExport size={18} />} title="Export & Import">
            <p>Use <strong className="text-white/90">Export Data</strong> in the sidebar to download all your conversations as a JSON file. You can import this file on another device or after clearing your data to restore your conversations.</p>
          </HelpSection>

          {/* Keyboard Shortcuts */}
          <HelpSection icon={<IconKeyboard size={18} />} title="Keyboard Shortcuts">
            <table className="w-full text-sm">
              <tbody>
                {[
                  ['Cmd/Ctrl + B', 'Toggle sidebar'],
                  ['Cmd/Ctrl + N', 'New conversation'],
                  ['Cmd/Ctrl + K', 'Search conversations'],
                  ['Enter', 'Send message'],
                  ['Shift + Enter', 'New line'],
                  ['Escape', 'Close dialogs'],
                ].map(([keys, desc]) => (
                  <tr key={keys} className="border-b border-white/5 last:border-0">
                    <td className="py-1.5 pr-4">
                      <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 text-xs font-mono">{keys}</kbd>
                    </td>
                    <td className="py-1.5 text-white/60">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </HelpSection>

          {/* PWA */}
          <HelpSection icon={<IconDeviceDesktop size={18} />} title="Install as App (PWA)">
            <p>Daedalus can be installed as a standalone app on your device for a native-like experience:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li><strong className="text-white/90">Desktop</strong> &mdash; click the install icon in your browser&apos;s address bar.</li>
              <li><strong className="text-white/90">Android</strong> &mdash; tap &ldquo;Add to Home Screen&rdquo; from the browser menu.</li>
              <li><strong className="text-white/90">iOS</strong> &mdash; in Safari, tap the share icon and select &ldquo;Add to Home Screen.&rdquo;</li>
            </ul>
            <p>The installed app supports background processing, real-time sync across devices, and offline access to your conversation history.</p>
          </HelpSection>
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-5 border-t border-white/10 flex-shrink-0">
          <button
            className="w-full py-3 px-4 rounded-xl bg-nvidia-green text-white hover:bg-nvidia-green-dark transition-all text-sm font-medium shadow-[0_0_20px_rgba(118,185,0,0.3)] hover:shadow-[0_0_30px_rgba(118,185,0,0.5)]"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
