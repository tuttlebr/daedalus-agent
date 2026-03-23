import { FC, useEffect, useState } from 'react';
import { IconBrain, IconTool } from '@tabler/icons-react';
import { BotAvatar } from '@/components/Avatar/BotAvatar';
import { IntermediateStepCategory } from '@/types/intermediateSteps';

interface Props {
  statusUpdateText: string;
  completedStepCategories?: IntermediateStepCategory[];
}

function CategoryIcon({ category }: { category: IntermediateStepCategory }) {
  if (category === IntermediateStepCategory.LLM) {
    return <IconBrain size={11} />;
  }
  return <IconTool size={11} />;
}

export const ChatLoader: FC<Props> = ({ statusUpdateText = '', completedStepCategories = [] }) => {
  const [isVisible, setIsVisible] = useState(!document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const visibleCategories = completedStepCategories.slice(-8);

  return (
    <div
      className="group px-3 sm:px-4 md:px-6 py-2 sm:py-3 animate-morph-in"
      style={{ overflowWrap: 'anywhere' }}
    >
      <div className="relative mx-auto flex w-full max-w-5xl text-base gap-2 sm:gap-3">
        <div className="flex-shrink-0 self-end mb-1 hidden sm:block">
          <BotAvatar src={'favicon.png'} height={24} width={24} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start">
          <div className="relative max-w-[85%] sm:max-w-[75%] md:max-w-[65%] px-4 py-3 sm:px-5 sm:py-4 rounded-3xl rounded-bl-lg bg-[color:var(--chat-bubble-assistant-bg)] dark:bg-[color:var(--chat-bubble-assistant-bg-dark)] text-gray-900 dark:text-gray-50 shadow-sm border border-[color:var(--chat-bubble-assistant-border)] dark:border-[color:var(--chat-bubble-assistant-border-dark)]">
            <div className="flex items-center gap-2">
              {statusUpdateText ? (
                <span className="cursor-default text-[15px] sm:text-[15.5px] leading-relaxed">
                  {statusUpdateText}
                  <span
                    className="text-nvidia-green inline-block ml-1"
                    style={{
                      animation: isVisible ? 'blink 1s ease-in-out infinite' : 'none',
                      animationPlayState: isVisible ? 'running' : 'paused',
                    }}
                  >
                    ▍
                  </span>
                </span>
              ) : (
                <div className="flex items-center gap-1.5 py-0.5">
                  <span className="typing-dot w-2 h-2 rounded-full bg-nvidia-green/70" />
                  <span className="typing-dot w-2 h-2 rounded-full bg-nvidia-green/70" />
                  <span className="typing-dot w-2 h-2 rounded-full bg-nvidia-green/70" />
                </div>
              )}
            </div>
            {visibleCategories.length > 0 && (
              <div className="flex items-center gap-1 mt-2 text-nvidia-green/40">
                {visibleCategories.map((cat, i) => (
                  <span key={i} className="flex items-center">
                    <CategoryIcon category={cat} />
                  </span>
                ))}
                <span className="w-1.5 h-1.5 rounded-full bg-nvidia-green/40 ml-0.5 flex-shrink-0 animate-pulse" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
