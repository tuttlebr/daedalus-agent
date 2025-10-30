import React from 'react';
import { IconPaperclip, IconCamera, /* IconMicrophone, */ IconBrain } from '@tabler/icons-react'; // Microphone icon commented out - Voice recording disabled

interface QuickActionsProps {
  onAttachFile: () => void;
  onTakePhoto: () => void;
  onToggleDeepThought?: () => void;
  isDeepThoughtEnabled?: boolean;
  className?: string;
}

export const QuickActions: React.FC<QuickActionsProps> = ({
  onAttachFile,
  onTakePhoto,
  onToggleDeepThought,
  isDeepThoughtEnabled = false,
  className = '',
}) => {
  const actions = [
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
  ];

  return (
    <div className={`relative w-full ${className}`}>
      {/* Action bar with Apple glass styling */}
      <div className={`flex w-full flex-col gap-3 rounded-2xl border border-white/15 bg-white/10 p-3 shadow-[0_14px_32px_rgba(6,15,11,0.35)] backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:bg-white/5 dark:shadow-[0_14px_38px_rgba(3,8,6,0.45)] ${className}`}>
        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={action.onClick}
              className="rounded-xl border border-white/10 bg-white/10 p-2.5 text-neutral-700 transition-all hover:border-nvidia-green/40 hover:bg-white/20 hover:text-nvidia-green dark:border-white/5 dark:bg-white/10 dark:text-white/70 dark:hover:border-nvidia-green/50 dark:hover:text-nvidia-green"
              aria-label={action.label}
              title={action.label}
            >
              {action.icon}
            </button>
          ))}
        </div>
        {onToggleDeepThought && (
          <button
            onClick={onToggleDeepThought}
            className={`
              flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-all sm:w-auto
              ${isDeepThoughtEnabled
                ? 'border-nvidia-green/60 bg-nvidia-green/15 text-nvidia-green shadow-[0_10px_25px_rgba(118,185,0,0.25)]'
                : 'border-white/15 bg-white/10 text-neutral-700 hover:border-nvidia-green/40 hover:text-nvidia-green dark:text-white/70 dark:border-white/10 dark:bg-white/5'}
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
