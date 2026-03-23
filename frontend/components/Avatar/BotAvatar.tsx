import React, { memo, useCallback, useState } from 'react';

interface BotAvatarProps {
    height?: number;
    width?: number;
    src?: string;
}

export const BotAvatar = memo<BotAvatarProps>(({height = 30, width = 30, src= ''}) =>  {
    const [hasError, setHasError] = useState(false);

    const onError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
        if (!hasError) {
            setHasError(true);
            event.currentTarget.src = '/favicon.png';
        }
    }, [hasError]);

    if (hasError && !src) {
        return (
            <div
                className="rounded-full bg-nvidia-green/20 flex items-center justify-center text-nvidia-green font-semibold"
                style={{ width, height, fontSize: Math.max(10, height * 0.45) }}
                role="img"
                aria-label="Bot avatar"
            >
                D
            </div>
        );
    }

    return <img
        src={src}
        alt="Bot avatar"
        width={width}
        height={height}
        className='rounded-full max-w-full h-auto'
        onError={onError}
    />
});

BotAvatar.displayName = 'BotAvatar';
