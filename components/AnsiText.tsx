import React, { useMemo } from 'react';

interface AnsiTextProps {
  text: string;
}

export const AnsiText: React.FC<AnsiTextProps> = ({ text }) => {
  const parts = useMemo(() => {
    // Regex to match ANSI escape sequences: \x1b[...m
    // Matches sequences like \x1b[31m, \x1b[1;33m, etc.
    const regex = /\x1b\[([0-9;]*)m/g;
    const result = [];
    let lastIndex = 0;
    let match;

    let currentStyle: React.CSSProperties = {};

    while ((match = regex.exec(text)) !== null) {
      // 1. Text before the ANSI code
      if (match.index > lastIndex) {
        result.push({
          text: text.substring(lastIndex, match.index),
          style: { ...currentStyle }
        });
      }

      // 2. Parse the ANSI code(s)
      // Split by semicolon for multiple codes (e.g. 1;31)
      const codes = match[1].split(';').map(c => parseInt(c, 10) || 0);
      // If the match is empty \x1b[m, it implies reset (0)
      if (match[1] === '') codes.push(0);

      for (const code of codes) {
        if (code === 0) {
          // Reset
          currentStyle = {};
        } else if (code === 1) {
          // Bold
          currentStyle.fontWeight = 'bold';
        } else if (code >= 30 && code <= 37) {
          // Foreground Colors (Standard)
          const colors = [
            '#000000', // 30 Black
            '#ef4444', // 31 Red
            '#22c55e', // 32 Green
            '#eab308', // 33 Yellow
            '#3b82f6', // 34 Blue
            '#a855f7', // 35 Magenta
            '#06b6d4', // 36 Cyan
            '#e5e7eb'  // 37 White
          ];
          currentStyle.color = colors[code - 30];
        } else if (code >= 90 && code <= 97) {
          // Foreground Colors (Bright)
          const colors = [
            '#6b7280', // 90 Gray
            '#f87171', // 91 Bright Red
            '#4ade80', // 92 Bright Green
            '#facc15', // 93 Bright Yellow
            '#60a5fa', // 94 Bright Blue
            '#c084fc', // 95 Bright Magenta
            '#22d3ee', // 96 Bright Cyan
            '#ffffff'  // 97 Bright White
          ];
          currentStyle.color = colors[code - 90];
        } else if (code >= 40 && code <= 47) {
          // Background Colors
          const bgColors = [
            '#000000', // 40 Black
            '#7f1d1d', // 41 Red
            '#14532d', // 42 Green
            '#713f12', // 43 Yellow
            '#1e3a8a', // 44 Blue
            '#581c87', // 45 Magenta
            '#164e63', // 46 Cyan
            '#374151'  // 47 White (Grayish for bg)
          ];
          currentStyle.backgroundColor = bgColors[code - 40];
        }
      }

      lastIndex = regex.lastIndex;
    }

    // 3. Remaining text
    if (lastIndex < text.length) {
      result.push({
        text: text.substring(lastIndex),
        style: { ...currentStyle }
      });
    }

    return result;
  }, [text]);

  return (
    <span>
      {parts.map((part, i) => (
        <span key={i} style={part.style}>
          {part.text}
        </span>
      ))}
    </span>
  );
};