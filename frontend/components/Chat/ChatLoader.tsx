import { FC, useEffect, useState } from 'react';
import { BotAvatar } from '@/components/Avatar/BotAvatar';

interface Props {
  statusUpdateText: string;
}

export const ChatLoader: FC<Props> = ({ statusUpdateText = '' }) => {
  const config = {
    initialDelay: 500,
    delayMultiplier: 6000,
    statusMessages: [statusUpdateText],
  };

  const [currentMessage, setCurrentMessage] = useState(''); // Initialize with empty string

  useEffect(() => {
    const timers = config.statusMessages.map((message, index) => {
      const delay = index === 0 ? config.initialDelay : config.initialDelay + (index * config.delayMultiplier);
      return setTimeout(() => {
        setCurrentMessage(message);
      }, delay);
    });

    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  return (
    <div
      className="group px-3 sm:px-4 md:px-6"
      style={{ overflowWrap: 'anywhere' }}
    >
      <div className="relative mx-auto flex w-full max-w-5xl py-4 text-base gap-3 sm:gap-4 md:gap-5">
        <div className="min-w-[40px] items-end">
          <BotAvatar src={'favicon.png'} height={30} width={30} />
        </div>
        <div className="flex items-center">
          {/* Status Update Text with Green Blinking Caret */}
          <span className="cursor-default">{currentMessage}<span className="text-nvidia-green animate-blink">▍</span></span>
        </div>
      </div>
    </div>
  );
};
