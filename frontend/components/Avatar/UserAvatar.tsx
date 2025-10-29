import React, { memo, useCallback } from 'react';
import { getInitials } from '@/utils/app/helper';

interface UserAvatarProps {
    src?: string;
    height?: number;
    width?: number;
}

export const UserAvatar = memo<UserAvatarProps>(({src = '', height = 30, width = 30}) =>  {
    const profilePicUrl = src || ``

    const onError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
            <rect width="100%" height="100%" fill="#fff"/>
            <text x="50%" y="50%" alignment-baseline="middle" text-anchor="middle" fill="#333" font-size="16" font-family="NVIDIA Sans">
                user
            </text>
        </svg>`;
        event.currentTarget.src = `data:image/svg+xml;base64,${window.btoa(svg)}`;
    }, [width, height]);

    return <img
        src={profilePicUrl}
        alt={'user-avatar'}
        width={width}
        height={height}
        title={'user-avatar'}
        className='rounded-full max-w-full h-auto border border-[#76b900]'
        onError={onError}
    />
});

UserAvatar.displayName = 'UserAvatar';
