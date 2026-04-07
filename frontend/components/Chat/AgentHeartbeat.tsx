import { FC, useEffect, useState, useRef } from 'react';
import { IconBrain, IconTool } from '@tabler/icons-react';
import { IntermediateStepCategory } from '@/types/intermediateSteps';

interface Props {
  currentActivityText: string;
  completedStepCategories: IntermediateStepCategory[];
  useDeepThinker?: boolean;
}

/**
 * Persistent "agent is alive" indicator shown throughout streaming.
 * Always renders a sweeping gradient bar + breathing dot so the user
 * can tell the agent hasn't hung, even during long gaps between
 * intermediate steps or token delivery.
 */
export const AgentHeartbeat: FC<Props> = ({
  currentActivityText,
  completedStepCategories,
  useDeepThinker = false,
}) => {
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

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem.toString().padStart(2, '0')}s`;
  };

  return (
    <div className="px-3 sm:px-4 md:px-6 py-1 animate-morph-in">
      <div className="relative mx-auto flex w-full max-w-5xl flex-col">
        {/* Sweeping gradient bar */}
        <div className="ml-0 sm:ml-9">
          <div
            className="agent-heartbeat-bar w-full max-w-xs"
            data-deep-thinker={useDeepThinker}
          />
        </div>

        {/* Status line */}
        <div className="ml-0 sm:ml-9 flex items-center gap-2 mt-1.5">
          {/* Completed step icons */}
          {completedStepCategories.slice(-6).map((cat, i) => (
            <span
              key={i}
              className={`flex items-center ${
                useDeepThinker ? 'text-nvidia-purple/35' : 'text-nvidia-green/35'
              }`}
            >
              {cat === IntermediateStepCategory.LLM ? (
                <IconBrain size={11} />
              ) : (
                <IconTool size={11} />
              )}
            </span>
          ))}

          {/* Breathing dot */}
          <span
            className={`heartbeat-dot w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              useDeepThinker ? 'bg-nvidia-purple' : 'bg-nvidia-green'
            }`}
          />

          {/* Activity text or fallback */}
          <span
            className={`text-[12px] select-none ${
              useDeepThinker ? 'text-nvidia-purple/60' : 'text-nvidia-green/60'
            }`}
          >
            {currentActivityText || 'Agent is working\u2026'}
          </span>

          {/* Elapsed timer */}
          <span
            className={`text-[11px] tabular-nums ml-auto ${
              useDeepThinker ? 'text-nvidia-purple/30' : 'text-nvidia-green/30'
            }`}
          >
            {formatElapsed(elapsed)}
          </span>
        </div>
      </div>
    </div>
  );
};
