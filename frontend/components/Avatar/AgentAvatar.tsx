import { IconUserPentagon } from '@tabler/icons-react';
import React, { memo } from 'react';

interface AgentAvatarProps {
    height?: number;
    width?: number;
}

export const AgentAvatar = memo<AgentAvatarProps>(({height = 7, width = 7}) =>  {
    return (
        <div className={`w-${width} h-${height} flex justify-center items-center rounded-full bg-nvidia-green-dark text-white`} title="Agent">
                <IconUserPentagon size={25}/>
        </div>
    )
});

AgentAvatar.displayName = 'AgentAvatar';
