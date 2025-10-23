/**
 * Galaxy Animation Component
 * A network-like galaxy animation with connected nodes and triangular shapes
 * Converted from Python's get_galaxy_animation_html function
 */

'use client';

import React from 'react';

interface GalaxyAnimationProps {
  containerSize?: number;
  animationDuration?: number;
  className?: string;
}

interface NodeConfig {
  radius: number;
  angle: number;
  type: 'triangle' | 'dot';
  size: number;
}

interface Connection {
  startIdx: number;
  endIdx: number;
}

export const GalaxyAnimation: React.FC<GalaxyAnimationProps> = ({
  containerSize = 150,
  animationDuration = 12,
  className = '',
}) => {
  const [isPaused, setIsPaused] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Check if user prefers reduced motion
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Pause animation when tab is not visible or when scrolled out of view
  React.useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPaused(document.hidden);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          setIsPaused(true);
        } else if (!document.hidden) {
          setIsPaused(false);
        }
      },
      { threshold: 0.1 }
    );

    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      observer.disconnect();
    };
  }, []);

  // If user prefers reduced motion, show static version
  if (prefersReducedMotion) {
    return (
      <div ref={containerRef} className={`relative ${className}`} style={{ width: containerSize, height: containerSize }}>
        <img src="/favicon.png" alt="Logo" className="w-full h-full object-contain" />
      </div>
    );
  }

  // Define network nodes with triangles at specific positions
  const nodesConfig: NodeConfig[] = [
    // Inner ring nodes
    { radius: 40, angle: 0, type: 'triangle', size: 12 },
    { radius: 45, angle: 60, type: 'dot', size: 4 },
    { radius: 40, angle: 120, type: 'triangle', size: 12 },
    { radius: 45, angle: 180, type: 'dot', size: 4 },
    { radius: 40, angle: 240, type: 'triangle', size: 12 },
    { radius: 45, angle: 300, type: 'dot', size: 4 },
    // Outer ring nodes
    { radius: 65, angle: 30, type: 'dot', size: 5 },
    { radius: 70, angle: 90, type: 'triangle', size: 14 },
    { radius: 65, angle: 150, type: 'dot', size: 5 },
    { radius: 70, angle: 210, type: 'triangle', size: 14 },
    { radius: 65, angle: 270, type: 'dot', size: 5 },
    { radius: 70, angle: 330, type: 'triangle', size: 14 },
  ];

  // Generate connection lines between nodes
  const connections: Connection[] = [
    // Inner ring connections
    { startIdx: 0, endIdx: 1 },
    { startIdx: 1, endIdx: 2 },
    { startIdx: 2, endIdx: 3 },
    { startIdx: 3, endIdx: 4 },
    { startIdx: 4, endIdx: 5 },
    { startIdx: 5, endIdx: 0 },
    // Outer ring connections
    { startIdx: 6, endIdx: 7 },
    { startIdx: 7, endIdx: 8 },
    { startIdx: 8, endIdx: 9 },
    { startIdx: 9, endIdx: 10 },
    { startIdx: 10, endIdx: 11 },
    { startIdx: 11, endIdx: 6 },
    // Cross connections
    { startIdx: 0, endIdx: 7 },
    { startIdx: 2, endIdx: 9 },
    { startIdx: 4, endIdx: 11 },
    { startIdx: 1, endIdx: 6 },
    { startIdx: 3, endIdx: 8 },
    { startIdx: 5, endIdx: 10 },
  ];

  // Helper function to convert polar to Cartesian coordinates
  const polarToCartesian = (radius: number, angle: number) => {
    const angleRad = (angle * Math.PI) / 180;
    return {
      x: radius * Math.cos(angleRad),
      y: radius * Math.sin(angleRad),
    };
  };

  // Render connection line
  const renderConnection = (connection: Connection, index: number) => {
    const start = nodesConfig[connection.startIdx];
    const end = nodesConfig[connection.endIdx];
    const startPos = polarToCartesian(start.radius, start.angle);
    const endPos = polarToCartesian(end.radius, end.angle);

    const length = Math.sqrt(
      Math.pow(endPos.x - startPos.x, 2) + Math.pow(endPos.y - startPos.y, 2)
    );
    const angle = Math.atan2(endPos.y - startPos.y, endPos.x - startPos.x) * (180 / Math.PI);

    const centerX = (startPos.x + endPos.x) / 2;
    const centerY = (startPos.y + endPos.y) / 2;

    return (
      <div
        key={`connection-${index}`}
        className="network-connection absolute"
        style={{
          width: `${length}px`,
          height: '1px',
          background: `linear-gradient(90deg, color-mix(in srgb, var(--galaxy-connection, var(--color-nvidia-green)), transparent 85%) 0%, var(--galaxy-connection, var(--color-nvidia-green-light)) 50%, color-mix(in srgb, var(--galaxy-connection, var(--color-nvidia-green)), transparent 85%) 100%)`,
          left: `calc(50% + ${centerX}px)`,
          top: `calc(50% + ${centerY}px)`,
          transform: `translate(-50%, -50%) rotate(${angle}deg)`,
          transformOrigin: 'center center',
          opacity: 0.4,
          animation: `connection-pulse 3s ease-in-out infinite ${(index * 0.1) % 1.6}s`,
        }}
      />
    );
  };

  // Render node
  const renderNode = (node: NodeConfig, index: number) => {
    const pos = polarToCartesian(node.radius, node.angle);
    const delay = (index * 0.2) % 1.2;

    if (node.type === 'triangle') {
      return (
        <div
          key={`node-${index}`}
          className="network-node triangle-node absolute"
          style={{
            width: 0,
            height: 0,
            borderLeft: `${node.size / 2}px solid transparent`,
            borderRight: `${node.size / 2}px solid transparent`,
            borderBottom: `${node.size}px solid var(--galaxy-node, var(--color-nvidia-green))`,
            left: '50%',
            top: '50%',
            transform: `translate(calc(${pos.x}px - ${node.size / 2}px), calc(${pos.y}px - ${node.size / 2}px))`,
            filter: 'drop-shadow(0 0 3px var(--galaxy-glow, var(--color-nvidia-green)))',
            animation: `node-expand-${index} 4s ease-in-out infinite ${delay}s, triangle-glow 2s ease-in-out infinite ${delay}s`,
            animationPlayState: isPaused ? 'paused' : 'running',
          }}
        />
      );
    } else {
      return (
        <div
          key={`node-${index}`}
          className="network-node dot-node absolute"
          style={{
            width: `${node.size}px`,
            height: `${node.size}px`,
            background: `radial-gradient(circle, var(--galaxy-node, var(--color-nvidia-green)) 0%, color-mix(in srgb, var(--galaxy-node, var(--color-nvidia-green)), transparent 40%) 60%, transparent 100%)`,
            borderRadius: '50%',
            left: '50%',
            top: '50%',
            transform: `translate(calc(${pos.x}px - ${node.size / 2}px), calc(${pos.y}px - ${node.size / 2}px))`,
            boxShadow: '0 0 4px color-mix(in srgb, var(--galaxy-glow, var(--color-nvidia-green)), transparent 20%)',
            animation: `node-expand-${index} 4s ease-in-out infinite ${delay}s, node-pulse 2.5s ease-in-out infinite ${delay}s`,
            animationPlayState: isPaused ? 'paused' : 'running',
          }}
        />
      );
    }
  };

  // Generate dynamic keyframes for node expansion
  const generateNodeKeyframes = () => {
    return nodesConfig.map((node, index) => {
      const pos = polarToCartesian(node.radius, node.angle);
      const expandedPos = {
        x: pos.x * 1.3,
        y: pos.y * 1.3,
      };
      const sizeOffset = node.size / 2;

      return `
        @keyframes node-expand-${index} {
          0% {
            transform: translate(calc(${pos.x}px - ${sizeOffset}px), calc(${pos.y}px - ${sizeOffset}px));
          }
          50% {
            transform: translate(calc(${expandedPos.x}px - ${sizeOffset}px), calc(${expandedPos.y}px - ${sizeOffset}px));
          }
          100% {
            transform: translate(calc(${pos.x}px - ${sizeOffset}px), calc(${pos.y}px - ${sizeOffset}px));
          }
        }
      `;
    }).join('\n');
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
          @keyframes galaxy-rotate {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(-360deg); }
          }

          @keyframes network-breathe {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }

          @keyframes node-pulse {
            0%, 100% {
              opacity: 0.8;
              transform: scale(1);
            }
            50% {
              opacity: 1;
              transform: scale(1.2);
            }
          }

          @keyframes connection-pulse {
            0%, 100% {
              opacity: 0.2;
              filter: blur(0px);
            }
            50% {
              opacity: 0.5;
              filter: blur(0.5px);
            }
          }

          @keyframes triangle-glow {
            0%, 100% {
              filter: drop-shadow(0 0 3px var(--galaxy-glow, var(--color-nvidia-green))) drop-shadow(0 0 6px var(--galaxy-glow, var(--color-nvidia-green)));
            }
            50% {
              filter: drop-shadow(0 0 6px var(--galaxy-glow, var(--color-nvidia-green))) drop-shadow(0 0 12px var(--galaxy-glow, var(--color-nvidia-green)));
            }
          }

          ${generateNodeKeyframes()}
        `
      }} />

      <div
        ref={containerRef}
        className={`galaxy-container relative mx-auto ${className}`}
        style={{
          width: `${containerSize}px`,
          height: `${containerSize}px`,
        }}
      >
        <div
          className="network-container absolute w-full h-full"
          style={{
            animation: `galaxy-rotate ${animationDuration}s linear infinite, network-breathe 6s ease-in-out infinite`,
            animationPlayState: isPaused ? 'paused' : 'running',
          }}
        >
          {/* Render connections */}
          {connections.map((connection, index) => renderConnection(connection, index))}

          {/* Render nodes */}
          {nodesConfig.map((node, index) => renderNode(node, index))}
        </div>

        {/* Center mask to hide artifacts */}
        <div
          className="absolute pointer-events-none"
          style={{
            width: '10px',
            height: '10px',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'radial-gradient(circle, rgba(24, 25, 26, 1) 0%, rgba(24, 25, 26, 0.8) 50%, transparent 100%)',
            zIndex: 20,
          }}
        />
      </div>
    </>
  );
};
