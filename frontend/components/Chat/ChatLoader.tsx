import { FC } from 'react';
import { BotAvatar } from '@/components/Avatar/BotAvatar';

interface Props {
  useDeepThinker?: boolean;
}

export const ChatLoader: FC<Props> = ({ useDeepThinker = false }) => {
  const dotClass = useDeepThinker
    ? 'typing-dot w-2 h-2 rounded-full bg-nvidia-purple opacity-70'
    : 'typing-dot w-2 h-2 rounded-full bg-nvidia-green opacity-70';

  return (
    <div
      className="group px-3 sm:px-4 md:px-6 py-2 sm:py-3 animate-morph-in"
      style={{ overflowWrap: 'anywhere' }}
    >
      <div className="relative mx-auto flex w-full max-w-5xl flex-row justify-start pr-8 sm:pr-14 gap-2 sm:gap-3">
        <div className="flex-shrink-0 self-end mb-1 hidden sm:block">
          <BotAvatar src={'favicon.png'} height={24} width={24} />
        </div>
        <div className="min-w-0">
          <div className="relative max-w-[85%] sm:max-w-[75%] md:max-w-[65%] px-4 py-3 sm:px-5 sm:py-4 rounded-3xl rounded-bl-lg bg-[color:var(--chat-bubble-assistant-bg)] dark:bg-[color:var(--chat-bubble-assistant-bg-dark)] text-gray-900 dark:text-gray-50 shadow-sm border border-[color:var(--chat-bubble-assistant-border)] dark:border-[color:var(--chat-bubble-assistant-border-dark)] mr-auto">
            <div className="flex items-center gap-1.5 py-0.5">
              <span className={dotClass} />
              <span className={dotClass} />
              <span className={dotClass} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
