"use client";
import React from "react";
import Image from "next/image";

export const GalaxyAnimation: React.FC<{ className?: string }> = ({ className = "" }) => {
  return (
    <div
      className={className}
      style={{
        width: 160,
        height: 160,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Image
        src="/main-logo.png"
        alt="Logo"
        width={160}
        height={160}
        priority
        style={{
          objectFit: "contain",
        }}
      />
    </div>
  );
};

export default GalaxyAnimation;
