'use client';

import { memo, useState, useEffect, useRef } from 'react';
import classNames from 'classnames';
import { IconBrain, IconTool, IconSearch, IconPhoto, IconCode, IconWorldWww } from '@tabler/icons-react';
import { IntermediateStepCategory } from '@/types/intermediateSteps';

interface AgentHeartbeatProps {
  currentActivityText: string;
  completedStepCategories: IntermediateStepCategory[];
}

const CATEGORY_ICONS: Partial<Record<string, React.ElementType>> = {
  llm: IconBrain,
  tool: IconTool,
  search: IconSearch,
  image: IconPhoto,
  code: IconCode,
  web: IconWorldWww,
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Agent streaming indicator with sweep bar, breathing dot, and activity text.
 * Shown during active response generation.
 */
export const AgentHeartbeat = memo(({
  currentActivityText,
  completedStepCategories,
}: AgentHeartbeatProps) => {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const accentColor = 'nvidia-green';
  const recentCategories = completedStepCategories.slice(-6);

  return (
    <div className="animate-morph-in">
      {/* Sweep bar */}
      <div
        className="h-0.5 w-full rounded-full animate-heartbeat-sweep"
        style={{ backgroundSize: '200% 100%' }}
      />

      {/* Activity row */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Step category icons */}
        <div className="flex items-center -space-x-1">
          {recentCategories.map((cat, i) => {
            const Icon = CATEGORY_ICONS[cat] || IconTool;
            return (
              <span
                key={`${cat}-${i}`}
                className={classNames(
                  'w-5 h-5 rounded-full flex items-center justify-center',
                  `bg-${accentColor}/20 text-${accentColor}`
                )}
              >
                <Icon size={12} />
              </span>
            );
          })}
        </div>

        {/* Breathing dot */}
        <span
          className={classNames(
            'w-2 h-2 rounded-full animate-heartbeat-breathe flex-shrink-0',
            `bg-${accentColor}`
          )}
        />

        {/* Activity text */}
        <span className="text-xs text-dark-text-muted truncate flex-1">
          {currentActivityText || 'Thinking...'}
        </span>

        {/* Elapsed timer */}
        <span className={classNames('text-xs font-mono flex-shrink-0', `text-${accentColor}/70`)}>
          {formatElapsed(elapsed)}
        </span>
      </div>
    </div>
  );
});

AgentHeartbeat.displayName = 'AgentHeartbeat';
