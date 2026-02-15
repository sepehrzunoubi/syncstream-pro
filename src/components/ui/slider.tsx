"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

interface SliderWithTooltipProps
  extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  formatValue?: (value: number) => string;
}

const SliderWithTooltip = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderWithTooltipProps
>(({ className, formatValue, ...props }, ref) => {
  const [showTooltip, setShowTooltip] = React.useState(false);
  const value = props.value ?? props.defaultValue ?? [0];

  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <SliderPrimitive.Root
        ref={ref}
        className={cn(
          "relative flex w-full touch-none select-none items-center group",
          className
        )}
        onPointerDown={() => setShowTooltip(true)}
        onPointerUp={() => setShowTooltip(false)}
        {...props}
      >
        <SliderPrimitive.Track className="relative h-[2px] w-full grow overflow-hidden rounded-full bg-white/[0.06]">
          <SliderPrimitive.Range className="absolute h-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
        </SliderPrimitive.Track>
        <TooltipPrimitive.Root open={showTooltip}>
          <TooltipPrimitive.Trigger asChild>
            <SliderPrimitive.Thumb className="block h-3.5 w-3.5 rounded-full bg-blue-500 border border-blue-400/50 shadow-[0_0_10px_rgba(59,130,246,0.4)] ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 cursor-grab active:cursor-grabbing active:scale-110" />
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side="top"
              sideOffset={8}
              className="z-50 rounded-md bg-neutral-900 border border-white/[0.08] px-2.5 py-1 text-xs font-mono font-semibold text-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.15)] animate-in fade-in-0 zoom-in-95"
            >
              {formatValue ? formatValue(value[0]) : value[0]}
              <TooltipPrimitive.Arrow className="fill-neutral-900" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </SliderPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
});
SliderWithTooltip.displayName = "SliderWithTooltip";

export { SliderWithTooltip };
