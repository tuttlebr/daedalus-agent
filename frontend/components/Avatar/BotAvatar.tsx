import React, { memo, useCallback } from 'react';

interface BotAvatarProps {
    height?: number;
    width?: number;
    src?: string;
}

export const BotAvatar = memo<BotAvatarProps>(({height = 30, width = 30, src= ''}) =>  {

    const onError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
        console.error('error loading bot avatar');
        event.currentTarget.src = `favicon.png`;
    }, []);

    return <img
        src={src}
        alt="bot-avatar"
        width={width}
        height={height}
        className='rounded-full max-w-full h-auto'
        onError={onError}
    />
});

BotAvatar.displayName = 'BotAvatar';
