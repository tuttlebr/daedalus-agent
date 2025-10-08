'use client'

import React, { useContext } from 'react';
import HomeContext from '@/pages/api/home/home.context';
import { getWorkflowName } from '@/utils/app/helper';

export const ChatHeader = () => {
  const workflow = getWorkflowName();

  const {
    state: { selectedConversation },
  } = useContext(HomeContext);

  const hasMessages = Boolean(selectedConversation?.messages?.length);

  return (
    <header
      className="top-0 z-20 flex h-14 w-full items-center justify-center border-b border-transparent bg-transparent px-4 text-sm transition-colors duration-300 sm:px-6"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top))',
      }}
    >
      {hasMessages && (
        <div className="flex w-full max-w-5xl items-center justify-center">
          <div className="truncate text-base font-medium text-neutral-700 dark:text-neutral-200">
            {workflow}
          </div>
        </div>
      )}
    </header>
  );
};
