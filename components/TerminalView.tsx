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
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
      },
      convertEol: true, // Treat \n as \r\n for display
      scrollback: 50000, // Increased buffer
      macOptionIsMeta: true, // Better Alt key handling on Mac
      allowProposedApi: true,
    });

    // --- Key Event Interception ---
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        // Keys that should NOT perform default browser actions (like scrolling)
        const preventDefaultKeys = [
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            'Home', 'End', 'PageUp', 'PageDown', 
            'Tab'
        ];

        if (preventDefaultKeys.includes(event.code) || preventDefaultKeys.includes(event.key)) {
            event.preventDefault();
            return true; // Let xterm handle it
        }

        // Always allow F12 (DevTools)
        if (event.code === 'F12') return true;
        
        // Ctrl+A/C/V etc.
        // Returning true means xterm handles it.
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
    if (fitAddon) {
      try {
        fitAddon.fit();
      } catch (e) { console.warn("Initial fit failed", e); }
    }

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
      if (fitAddon) {
        try {
           fitAddon.fit();
        } catch (e) {}
      }
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

  return (
    <div 
      className="w-full h-full bg-black outline-none" 
      ref={containerRef} 
      tabIndex={-1} // Helps with focus management
    />
  );
});