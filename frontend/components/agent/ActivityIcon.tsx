import {
  IconAlertCircle,
  IconBrain,
  IconCheck,
  IconClock,
  IconFileText,
  IconHandStop,
  IconPencil,
  IconPhoto,
  IconPlayerPause,
  IconRefresh,
  IconSearch,
  IconTerminal2,
  IconTool,
  IconWorldWww,
} from '@tabler/icons-react';

import type {
  ConsolidatedStep,
  OperationStatus,
} from '@/utils/app/intermediateSteps';

import { IntermediateStepCategory } from '@/types/intermediateSteps';

interface ActivityIconProps {
  step?: ConsolidatedStep;
  status: OperationStatus;
  writing?: boolean;
  size?: number;
}

export function ActivityIcon({
  step,
  status,
  writing,
  size = 16,
}: ActivityIconProps) {
  const name = `${step?.friendlyName || ''} ${
    step?.startStep.payload.name || ''
  }`.toLowerCase();
  let Icon = IconBrain;
  if (writing) Icon = IconPencil;
  else if (step?.category === IntermediateStepCategory.TOOL) {
    Icon = /search|milvus/.test(name)
      ? IconSearch
      : /web|browse|scrape|url/.test(name)
      ? IconWorldWww
      : /document|file|ingest|read/.test(name)
      ? IconFileText
      : /sandbox|python|code|terminal/.test(name)
      ? IconTerminal2
      : /image|photo|visual/.test(name)
      ? IconPhoto
      : IconTool;
  }
  if (status === 'failed') Icon = IconAlertCircle;
  else if (status === 'interrupted') Icon = IconPlayerPause;
  else if (status === 'queued') Icon = IconClock;
  else if (status === 'waiting') Icon = IconHandStop;
  else if (status === 'retrying') Icon = IconRefresh;
  else if (!step && status === 'completed') Icon = IconCheck;
  return <Icon size={size} aria-hidden="true" />;
}
