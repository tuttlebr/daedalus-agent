import { IconPasswordUser, IconUserPentagon } from '@tabler/icons-react';
import React, { memo } from 'react';

interface SystemAgentAvatarProps {
    height?: number;
    width?: number;
}

export const SystemAgentAvatar = memo<SystemAgentAvatarProps>(({height = 7, width = 7}) =>  {
    return (
        <div className={`w-${width} h-${height} flex justify-center items-center rounded-full bg-[#004D3C] text-white`} title="System Agent">
            <IconPasswordUser size={25}/>
        </div>
    )
});

SystemAgentAvatar.displayName = 'SystemAgentAvatar';
