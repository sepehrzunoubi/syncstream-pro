"use client";

import React from "react";

/**
 * Renders the Markdown the engine writes (headings, lists, bold, code and
 * paragraphs) without a dependency. Anything else is shown as text.
 */
export function SimpleMarkdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  const inline = (s: string): React.ReactNode[] => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, k) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^`[^`]+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
      return part;
    });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = (`h${level + 1}` as unknown) as "h2";
      blocks.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++}>{code.join("\n")}</pre>);
      continue;
    }
    const listItem = (l: string) => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (listItem(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: React.ReactNode[] = [];
      while (i < lines.length && listItem(lines[i])) {
        let item = listItem(lines[i])![1];
        i++;
        // Continuation lines of the same item
        while (i < lines.length && lines[i].trim() && !listItem(lines[i]) && !/^#{1,6}\s/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(<li key={items.length}>{inline(item)}</li>);
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (/^(\s*\|.*\|\s*)$/.test(line)) {
      // A pipe table: shown as plain monospace rows
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      blocks.push(<pre key={key++}>{rows.join("\n")}</pre>);
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !listItem(lines[i]) && !/^```/.test(lines[i]) && !/^\s*\|/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className="ss-prose">{blocks}</div>;
}
