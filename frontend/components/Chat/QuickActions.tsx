import React, { useState } from 'react';
import {
  IconPaperclip,
  IconCamera,
  IconMicrophone,
  IconMoodSmile,
  IconBrain,
  IconBolt,
  IconCode,
  IconBulb,
} from '@tabler/icons-react';

interface QuickAction {
  id: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  color?: string;
}

interface QuickActionsProps {
  onAttachFile: () => void;
  onTakePhoto: () => void;
  onStartVoice: () => void;
  onSelectPrompt?: (prompt: string) => void;
  onToggleDeepThought?: () => void;
  isDeepThoughtEnabled?: boolean;
  className?: string;
}

export const QuickActions: React.FC<QuickActionsProps> = ({
  onAttachFile,
  onTakePhoto,
  onStartVoice,
  onSelectPrompt,
  onToggleDeepThought,
  isDeepThoughtEnabled = false,
  className = '',
}) => {
  const [showPrompts, setShowPrompts] = useState(false);

  const quickPrompts = [
    { id: 'explain', text: 'Explain this concept simply', icon: <IconBulb size={16} /> },
    { id: 'code', text: 'Write code for', icon: <IconCode size={16} /> },
    { id: 'improve', text: 'How can I improve', icon: <IconBolt size={16} /> },
    { id: 'brainstorm', text: 'Help me brainstorm', icon: <IconBrain size={16} /> },
  ];

  const actions: QuickAction[] = [
    {
      id: 'attach',
      icon: <IconPaperclip size={20} />,
      label: 'Attach file',
      onClick: onAttachFile,
    },
    {
      id: 'camera',
      icon: <IconCamera size={20} />,
      label: 'Take photo',
      onClick: onTakePhoto,
    },
    {
      id: 'voice',
      icon: <IconMicrophone size={20} />,
      label: 'Voice message',
      onClick: onStartVoice,
    },
    {
      id: 'prompts',
      icon: <IconMoodSmile size={20} />,
      label: 'Quick prompts',
      onClick: () => setShowPrompts(!showPrompts),
    },
  ];

  return (
    <div className={`relative w-full ${className}`}>
      {/* Quick prompts popup
      {showPrompts && (
        <div className="absolute bottom-full left-0 right-0 mb-2 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 p-2 animate-slide-up">
          <div className="grid grid-cols-2 gap-2">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt.id}
                onClick={() => {
                  onSelectPrompt?.(prompt.text);
                  setShowPrompts(false);
                }}
                className="flex items-center gap-2 px-3 py-2 text-sm text-left rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <span className="text-nvidia-green">{prompt.icon}</span>
                <span className="text-gray-700 dark:text-gray-300">{prompt.text}</span>
              </button>
            ))}
          </div>
        </div>
      )} */}

      {/* Action bar with Apple glass styling */}
      <div className={`flex w-full flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between ${className}`}>
        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={action.onClick}
              className="rounded-lg p-2.5 text-white/60 transition-all hover:bg-white/10 hover:text-white active:scale-95"
              aria-label={action.label}
              title={action.label}
            >
              {action.icon}
            </button>
          ))}
        </div>
        {/* Deep thought toggle */}
        {onToggleDeepThought && (
          <button
            onClick={onToggleDeepThought}
            className={`
              flex w-full items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all sm:w-auto
              ${isDeepThoughtEnabled
                ? 'bg-white/20 text-nvidia-green backdrop-blur-sm'
                : 'bg-white/10 text-white/60 hover:text-white/80 backdrop-blur-sm'}
            `}
            aria-label="Toggle deep thought mode"
            title="Enable deep analysis with first-principles reasoning"
          >
            <IconBrain size={16} />
            <span className="text-xs sm:text-sm">Deep Thinker</span>
            <span
              className={`inline-flex h-2 w-2 rounded-full transition-colors ${
                isDeepThoughtEnabled ? 'bg-nvidia-green' : 'bg-white/30'
              }`}
            />
          </button>
        )}
      </div>
    </div>
  );
};
