'use client';

import {
  IconBrain,
  IconTool,
  IconSearch,
  IconPhoto,
  IconCode,
  IconWorldWww,
} from '@tabler/icons-react';
import { memo, useState, useEffect, useRef } from 'react';

import { IntermediateStepCategory } from '@/types/intermediateSteps';

import classNames from 'classnames';

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
 * Agent streaming indicator with three warm dots and activity text.
 * Shown during active response generation.
 */
export const AgentHeartbeat = memo(
  ({ currentActivityText, completedStepCategories }: AgentHeartbeatProps) => {
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

    const recentCategories = completedStepCategories.slice(-6);

    return (
      <div className="animate-morph-in">
        {/* Activity row */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Step category icons */}
          <div className="flex items-center -space-x-1">
            {recentCategories.map((cat, i) => {
              const Icon =
                CATEGORY_ICONS[String(cat).toLowerCase()] || IconTool;
              return (
                <span
                  key={`${cat}-${i}`}
                  className={classNames(
                    'w-5 h-5 rounded-full flex items-center justify-center',
                    'bg-panel text-primary',
                  )}
                >
                  <Icon size={12} />
                </span>
              );
            })}
          </div>

          <span className="typing-indicator" aria-hidden="true">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </span>

          {/* Activity text */}
          <span className="text-xs text-dark-text-muted truncate flex-1">
            {currentActivityText || 'Thinking...'}
          </span>

          {/* Elapsed timer */}
          <span className="text-xs font-mono flex-shrink-0 text-secondary">
            {formatElapsed(elapsed)}
          </span>
        </div>
      </div>
    );
  },
);

AgentHeartbeat.displayName = 'AgentHeartbeat';
