import { Conversation, Message } from '@/types/chat';
import { FolderInterface } from '@/types/folder';
import { IntermediateStepCategory } from '@/types/intermediateSteps';
import { t } from 'i18next';

export interface HomeInitialState {
  loading: boolean;
  lightMode: 'light' | 'dark';
  messageIsStreaming: boolean;
  folders: FolderInterface[];
  conversations: Conversation[];
  selectedConversation: Conversation | undefined;
  currentMessage: Message | undefined;
  showChatbar: boolean;
  currentFolder: FolderInterface | undefined;
  messageError: boolean;
  searchTerm: string;
  chatHistory: boolean;
  chatCompletionURL?: string;
  enableIntermediateSteps?: boolean;
  expandIntermediateSteps?: boolean;
  intermediateStepOverride?: boolean;
  autoScroll?: boolean;
  additionalConfig: any;
  intermediateStepsView: 'timeline' | 'category';
  intermediateStepsFilter: IntermediateStepCategory[];
  enableBackgroundProcessing?: boolean;
  useDeepThinker: boolean;
  showVoiceRecorder: boolean;
}

export const initialState: HomeInitialState = {
  loading: false,
  lightMode: 'dark',
  messageIsStreaming: false,
  folders: [],
  conversations: [],
  selectedConversation: undefined,
  currentMessage: undefined,
  showChatbar: true,
  currentFolder: undefined,
  messageError: false,
  searchTerm: '',
  chatHistory: process?.env?.NEXT_PUBLIC_CHAT_HISTORY_DEFAULT_ON === 'false' ? false : true,
  chatCompletionURL: process?.env?.NEXT_PUBLIC_HTTP_CHAT_COMPLETION_URL || 'http://daedalus-backend-default.daedalus.svc.cluster.local:8000/chat/stream',
  enableIntermediateSteps: true,
  expandIntermediateSteps: false,
  intermediateStepOverride: true,
  autoScroll: true,
  additionalConfig: {},
  intermediateStepsView: 'timeline',
  intermediateStepsFilter: [],
  useDeepThinker: false,
  showVoiceRecorder: false,
  enableBackgroundProcessing: true,
};
