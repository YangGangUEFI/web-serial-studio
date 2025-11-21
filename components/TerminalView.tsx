import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

interface TerminalViewProps {
  onInput: (data: string) => void;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  clear: () => void;
  reset: () => void;
  fit: () => void;
  focus: () => void;
}

export const TerminalView = forwardRef<TerminalRef, TerminalViewProps>(({ onInput }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<any>(null);

  useImperativeHandle(ref, () => ({
    write: (data: string | Uint8Array) => {
      terminalRef.current?.write(data);
    },
    clear: () => {
      terminalRef.current?.clear();
    },
    reset: () => {
      terminalRef.current?.reset();
    },
    fit: () => {
      fitAddonRef.current?.fit();
    },
    focus: () => {
      terminalRef.current?.focus();
    }
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm.js
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Menlo", "Consolas", "Liberation Mono", monospace',
      theme: {
        background: '#000000',
        foreground: '#e5e7eb', // Gray-200
        cursor: '#ffffff',
      },
      convertEol: true, // Treat \n as \r\n for display
      scrollback: 10000,
      macOptionIsMeta: true, // Better Alt key handling on Mac
      allowProposedApi: true,
    });

    // --- Key Event Interception ---
    // Allows xterm to capture keys that browsers normally grab (F1-F12, Ctrl+..., etc)
    term.attachCustomKeyEventHandler((event) => {
      // Filter out copy/paste so user can still use them if they want (optional)
      // But usually standard terminals handle Ctrl+C as break signal (0x03)
      // If users want browser copy/paste, they usually use context menu or Ctrl+Shift+C/V in terminals
      
      if (event.type === 'keydown') {
        // Always allow F12 (DevTools) and F5 (Refresh) during development? 
        // For a "Native Like" app, we usually block them, but let's allow F12 for debug.
        if (event.code === 'F12') return true;

        // Allow Copy (Ctrl+C) only if there is a text selection in the terminal?
        // Standard xterm behavior: Ctrl+C sends \x03. To copy, users usually select text.
        // We will allow xterm to consume everything else.
        
        // Capture F1-F12, Arrow keys, Tab, Esc, etc.
        // Capture Ctrl+Key combinations (except maybe Ctrl+R/F5 if you really want refresh)
        
        return true; // Returning true allows xterm to process the key. Returning false stops it.
      }
      return true;
    });

    // Instantiate FitAddon
    let fitAddon;
    try {
      const FitAddonConstructor = (FitAddon as any).FitAddon || FitAddon;
      fitAddon = new FitAddonConstructor();
      term.loadAddon(fitAddon);
    } catch (e) {
      console.error("Failed to load FitAddon", e);
    }

    term.open(containerRef.current);
    if (fitAddon) fitAddon.fit();

    // Focus terminal on mount so keys work immediately
    term.focus();

    // Hook data event
    term.onData((data) => {
      onInput(data);
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle Window Resize
    const handleResize = () => {
      if (fitAddon) fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    // Add click listener to container to ensure focus
    const handleContainerClick = () => {
      term.focus();
    };
    containerRef.current.addEventListener('click', handleContainerClick);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (containerRef.current) {
        containerRef.current.removeEventListener('click', handleContainerClick);
      }
      term.dispose();
    };
  }, [onInput]);

  return <div className="w-full h-full bg-black" ref={containerRef} />;
});