'use client';

import React, { memo } from 'react';
import classNames from 'classnames';
import Image from 'next/image';

export type AvatarRole = 'user' | 'assistant' | 'agent' | 'system';
export type AvatarSize = 'sm' | 'md' | 'lg';

const sizeClasses: Record<AvatarSize, { container: string; icon: number }> = {
  sm: { container: 'w-7 h-7', icon: 14 },
  md: { container: 'w-9 h-9', icon: 18 },
  lg: { container: 'w-12 h-12', icon: 24 },
};

const roleColors: Record<AvatarRole, string> = {
  user: 'bg-nvidia-green/20 text-nvidia-green border-nvidia-green/30',
  assistant: 'bg-dark-bg-quaternary text-dark-text-secondary border-white/10',
  agent: 'bg-nvidia-purple/20 text-nvidia-purple border-nvidia-purple/30',
  system: 'bg-nvidia-blue/20 text-nvidia-blue border-nvidia-blue/30',
};

export interface AvatarProps {
  role: AvatarRole;
  size?: AvatarSize;
  src?: string;
  alt?: string;
  icon?: React.ReactNode;
  className?: string;
}

export const Avatar = memo(({
  role,
  size = 'md',
  src,
  alt,
  icon,
  className = '',
}: AvatarProps) => {
  const sizeConfig = sizeClasses[size];

  return (
    <div
      className={classNames(
        'flex-shrink-0 rounded-full flex items-center justify-center border overflow-hidden',
        sizeConfig.container,
        roleColors[role],
        className
      )}
    >
      {src ? (
        <Image
          src={src}
          alt={alt || role}
          width={sizeConfig.icon * 2}
          height={sizeConfig.icon * 2}
          className="w-full h-full object-cover"
        />
      ) : icon ? (
        <span className="flex items-center justify-center">{icon}</span>
      ) : (
        <RoleIcon role={role} size={sizeConfig.icon} />
      )}
    </div>
  );
});

Avatar.displayName = 'Avatar';

function RoleIcon({ role, size }: { role: AvatarRole; size: number }) {
  const s = size;
  switch (role) {
    case 'user':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M20 21a8 8 0 1 0-16 0" />
        </svg>
      );
    case 'assistant':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z" />
          <circle cx="9" cy="13" r="1" fill="currentColor" />
          <circle cx="15" cy="13" r="1" fill="currentColor" />
        </svg>
      );
    case 'agent':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      );
    case 'system':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
  }
}
