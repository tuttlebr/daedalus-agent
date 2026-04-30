// First, define the Video component at module level
'use client'

import { memo, useRef } from "react";
import Loading from "@/components/markdown/Loading";

interface VideoProps {
  src?: string;
  controls?: boolean;
  muted?: boolean;
  [key: string]: any;
}

export const Video = memo(({
    src,
    controls = true,
    muted = false,
    ...props
  }: VideoProps) => {
    // Use ref to maintain stable reference for video element
    const videoRef = useRef(null);

    if (src === 'loading') {
      return <Loading message='Loading...' type='image' />;
    }

    return (
      <video
        ref={videoRef}
        src={src}
        controls={controls}
        autoPlay={false}
        loop={false}
        muted={muted}
        playsInline={false}
        className="rounded-md border border-slate-400 shadow-sm object-cover"
        {...props}
      >
        Your browser does not support the video tag.
      </video>
    );
  }, (prevProps: VideoProps, nextProps: VideoProps) => {
    return prevProps.src === nextProps.src;
  });
