"use client";

import React from "react";
import { Label } from "@/components/ui/label";

interface SourceInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export function SourceInput({ value, onChange, disabled }: SourceInputProps) {
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center justify-between">
        <Label>Source Editor</Label>
        {value && (
          <span className="text-[0.55rem] font-mono text-zinc-600">
            {value.length.toLocaleString()} chars
          </span>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Paste the text you want to stream into Google Docs…"
        className="flex-1 min-h-[280px] w-full bg-transparent border-none rounded-lg px-3 py-3 text-[13px] leading-relaxed text-zinc-300 font-mono placeholder:text-zinc-700 resize-none focus:outline-none disabled:opacity-40 transition-colors"
      />
    </div>
  );
}
