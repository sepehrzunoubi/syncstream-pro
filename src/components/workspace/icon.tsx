import React from "react";

/** A Material Symbols icon. Names must be in the icon subset loaded by the dashboard layout. */
export function Icon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  return (
    <span className={`ss-icon ${className ?? ""}`} style={{ fontSize: size }} aria-hidden="true">
      {name}
    </span>
  );
}
