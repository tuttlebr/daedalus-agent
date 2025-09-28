'use client'

import React, { useContext, useState } from 'react';
import {
  IconArrowsSort,
  IconMobiledataOff,
  IconChevronLeft,
  IconChevronRight
} from '@tabler/icons-react';
import HomeContext from '@/pages/api/home/home.context';
import { getWorkflowName } from '@/utils/app/helper';
import { GalaxyAnimation } from '@/components/GalaxyAnimation';

export const ChatHeader = ({ webSocketModeRef = {} }) => {
    const [isExpanded, setIsExpanded] = useState(process?.env?.NEXT_PUBLIC_RIGHT_MENU_OPEN === 'true' ? true : false);

    const workflow = getWorkflowName()

    const {
        state: {
          chatHistory,
          webSocketMode,
          webSocketConnected,
          selectedConversation
        },
        dispatch: homeDispatch,
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

            {/* Collapsible Menu */}
            <div className={`fixed right-0 top-0 h-12 flex items-center transition-all duration-300 ${isExpanded ? 'mr-2' : 'mr-2'}`}>
                <button
                    onClick={() => {
                        setIsExpanded(!isExpanded)}
                    }
                    className="flex p-2 text-black dark:text-white transition-colors touch-target rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                    aria-label={isExpanded ? "Collapse menu" : "Expand menu"}
                >
                    {isExpanded ? <IconChevronRight size={20} /> : <IconChevronLeft size={20} />}
                </button>

                <div className={`flex gap-2 sm:gap-3 md:gap-4 overflow-hidden transition-all duration-300 ${isExpanded ? 'w-auto opacity-100' : 'w-0 opacity-0'}`}>
                    {/* Chat History Toggle */}
                    <div className="flex items-center gap-2 whitespace-nowrap">
                        <label className="flex items-center gap-2 cursor-pointer flex-shrink-0 p-1">
                            <span className="text-xs sm:text-sm font-medium text-black dark:text-white hide-mobile">Chat History</span>
                            <span className="text-xs sm:text-sm font-medium text-black dark:text-white show-mobile">History</span>
                            <div
                                onClick={() => {
                                    sessionStorage.setItem('chatHistory', String(!chatHistory));
                                    homeDispatch({
                                        field: 'chatHistory',
                                        value: !chatHistory,
                                    });
                                }}
                                className={`relative inline-flex h-6 w-12 sm:h-5 sm:w-10 items-center cursor-pointer rounded-full transition-colors duration-300 ease-in-out touch-target ${
                                    chatHistory ? 'bg-black dark:bg-nvidia-green' : 'bg-gray-200'
                                }`}
                                role="switch"
                                aria-checked={chatHistory}
                                aria-label="Toggle chat history"
                            >
                                <span className={`inline-block h-5 w-5 sm:h-4 sm:w-4 transform rounded-full bg-white transition-transform duration-300 ease-in-out ${
                                    chatHistory ? 'translate-x-6' : 'translate-x-1'
                                }`} />
                            </div>
                        </label>
                    </div>

                    {/* WebSocket Mode Toggle */}
                    <div className="flex items-center gap-2 whitespace-nowrap">
                        <label className="flex items-center gap-2 cursor-pointer flex-shrink-0 p-1">
                            <span className={`flex items-center gap-1 justify-evenly text-xs sm:text-sm font-medium text-black dark:text-white`}>
                                <span className="hide-mobile">WebSocket</span>
                                <span className="show-mobile">WS</span>{' '}
                                {webSocketModeRef?.current && (
                                    webSocketConnected ? <IconArrowsSort size={18} className="text-nvidia-green" /> : <IconMobiledataOff size={18} className="text-red-500" />
                                )}
                            </span>
                            <div
                                onClick={() => {
                                    const newWebSocketMode = !webSocketModeRef.current;
                                    sessionStorage.setItem('webSocketMode', String(newWebSocketMode));
                                    webSocketModeRef.current = newWebSocketMode;
                                    homeDispatch({
                                        field: 'webSocketMode',
                                        value: !webSocketMode,
                                    });
                                }}
                                className={`relative inline-flex h-6 w-12 sm:h-5 sm:w-10 items-center cursor-pointer rounded-full transition-colors duration-300 ease-in-out touch-target ${
                                    webSocketModeRef.current ? 'bg-black dark:bg-nvidia-green' : 'bg-gray-200'
                                }`}
                                role="switch"
                                aria-checked={webSocketModeRef.current}
                                aria-label="Toggle WebSocket mode"
                            >
                                <span className={`inline-block h-5 w-5 sm:h-4 sm:w-4 transform rounded-full bg-white transition-transform duration-300 ease-in-out ${
                                    webSocketModeRef.current ? 'translate-x-6' : 'translate-x-1'
                                }`} />
                            </div>
                        </label>
                    </div>
                </div>
            </div>
        </div>
    );
};
