import { Conversation, Message } from '@/types/chat';
import { FolderInterface } from '@/types/folder';
import { IntermediateStepCategory } from '@/types/intermediateSteps';
import { t } from 'i18next';
import { getDefaultChatCompletionUrl } from '@/utils/app/backendApi';

export interface HomeInitialState {
  loading: boolean;
  lightMode: 'light' | 'dark';
  messageIsStreaming: boolean;
  streamingByConversationId: Record<string, boolean>;
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
  additionalConfig: Record<string, unknown>;
  intermediateStepsView: 'timeline' | 'category';
  intermediateStepsFilter: IntermediateStepCategory[];
  enableBackgroundProcessing?: boolean;
  useDeepThinker: boolean;
  // showVoiceRecorder: boolean; // COMMENTED OUT - Voice recording disabled
  energySavingMode?: boolean;
  chatbarWidth: number;
}

export const initialState: HomeInitialState = {
  loading: false,
  lightMode: 'dark',
  messageIsStreaming: false,
  streamingByConversationId: {},
  folders: [],
  conversations: [],
  selectedConversation: undefined,
  currentMessage: undefined,
  showChatbar: false,
  currentFolder: undefined,
  messageError: false,
  searchTerm: '',
  chatHistory: process?.env?.NEXT_PUBLIC_CHAT_HISTORY_DEFAULT_ON === 'false' ? false : true,
  chatCompletionURL: getDefaultChatCompletionUrl(),
  enableIntermediateSteps: true,
  expandIntermediateSteps: false,
  intermediateStepOverride: true,
  autoScroll: true,
  additionalConfig: {},
  intermediateStepsView: 'timeline',
  intermediateStepsFilter: [],
  useDeepThinker: false,
  // showVoiceRecorder: false, // COMMENTED OUT - Voice recording disabled
  enableBackgroundProcessing: true,
  energySavingMode: false,
  chatbarWidth: 260,
};
