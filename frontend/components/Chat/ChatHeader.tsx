'use client'

import React, { useContext } from 'react';
import HomeContext from '@/pages/api/home/home.context';
import { getWorkflowName } from '@/utils/app/helper';
import { GalaxyAnimation } from '@/components/GalaxyAnimation';

export const ChatHeader = ({ webSocketModeRef = {} }) => {

    const workflow = getWorkflowName()

    const {
        state: {
          selectedConversation
        }
      } = useContext(HomeContext);

    return (
        <div className={`top-0 z-10 flex justify-center items-center h-12 ${selectedConversation?.messages?.length === 0 ? 'bg-none' : 'bg-nvidia-green sticky'} py-3 px-4 text-sm text-white dark:border-none dark:bg-black dark:text-neutral-200`} style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'calc(env(safe-area-inset-left) + 0.75rem)', paddingRight: 'calc(env(safe-area-inset-right) + 0.75rem)' }}>
            {
                selectedConversation?.messages?.length > 0 ?
                <div className={`absolute top-6 left-1/2 transform -translate-x-1/2 -translate-y-1/2`}>
                    <span className="text-lg font-medium text-white">{workflow}</span>
                </div>
                :
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                  <GalaxyAnimation containerSize={200} />
                </div>
            }
        </div>
    );
};
