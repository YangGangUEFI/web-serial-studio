

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConfigPanel } from './components/ConfigPanel';
import { Button } from './components/Button';
import { TerminalView, TerminalRef } from './components/TerminalView';
import { SerialPort, DisplayMode, SendMode, ParityType, FlowControlType } from './types';
import { bufferToHex, hexStringToBuffer, downloadBlob, formatTimestamp, concatUint8Arrays, formatHexDumpLine } from './utils';

// Web Serial API Polyfill for TypeScript
declare global {
  interface Navigator {
    serial: {
      requestPort(options?: any): Promise<SerialPort>;
      getPorts(): Promise<SerialPort[]>;
    };
  }
}

interface HistoryItem {
  timestamp: number;
  data: Uint8Array;
}

const App: React.FC = () => {
  // --- State ---
  const [port, setPort] = useState<SerialPort | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  
  // Serial Config State
  const [baudRate, setBaudRate] = useState(115200);
  const [dataBits, setDataBits] = useState(8);
  const [stopBits, setStopBits] = useState(1);
  const [parity, setParity] = useState<ParityType>('none');
  const [flowControl, setFlowControl] = useState<FlowControlType>('none');

  // Logs / Display Settings
  const [displayMode, setDisplayMode] = useState<DisplayMode>(DisplayMode.TEXT);
  const [showTimestamp, setShowTimestamp] = useState(false);
  
  // Input Mode
  const [bottomInputMode, setBottomInputMode] = useState<SendMode>(SendMode.TEXT);
  const [bottomInputText, setBottomInputText] = useState('');
  const [addCRLF, setAddCRLF] = useState(false);

  // Transmission State
  const [txProgress, setTxProgress] = useState<number | null>(null);
  const [txFileName, setTxFileName] = useState<string>('');
  
  // --- Refs ---
  const keepReading = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const terminalRef = useRef<TerminalRef>(null);

  // Cancellation control
  const isTxCancelled = useRef(false);

  // History buffer stores raw data with metadata
  const rxHistory = useRef<HistoryItem[]>([]); 
  
  // Batching for smooth UI updates
  const pendingChunks = useRef<HistoryItem[]>([]);

  // State tracking for line-based timestamping in TEXT mode
  const lastCharWasNewline = useRef(true);

  // State tracking for Hexdump mode
  const hexBuffer = useRef<Uint8Array>(new Uint8Array(0));
  const hexOffset = useRef(0);
  const isHexPartialPrinted = useRef(false);

  // --- Helpers ---

  // NOTE: This function is ONLY used for "Formatted" Text mode + Timestamp logs.
  const formatDataForTextLog = (item: HistoryItem, withTime: boolean, isNewLineStart: boolean): { text: string, endsWithNewline: boolean } => {
    const tsString = withTime ? `\x1b[32m${formatTimestamp(item.timestamp)}\x1b[0m ` : '';
    
    // We must decode and inject timestamps.
    let textStr = new TextDecoder().decode(item.data);
    
    if (withTime) {
      let formatted = '';
      if (isNewLineStart) {
        formatted += tsString;
      }
      // Inject timestamp after every newline
      formatted += textStr.replace(/\n/g, `\n${tsString}`);
      
      const endsWithNL = textStr.endsWith('\n');
      return { text: formatted, endsWithNewline: endsWithNL };
    }
    
    return { text: textStr, endsWithNewline: textStr.endsWith('\n') };
  };

  const writeBatchToTerminal = (items: HistoryItem[], isRepaint = false) => {
    if (!terminalRef.current || items.length === 0) return;

    // --- MODE 1: Raw Text (Direct Pass-through) ---
    if (displayMode === DisplayMode.TEXT && !showTimestamp) {
        const rawBuffers = items.map(i => i.data);
        const merged = concatUint8Arrays(rawBuffers);
        terminalRef.current.write(merged);
        if (isRepaint) lastCharWasNewline.current = true;
        return;
    }

    // --- MODE 2: Hexdump ---
    if (displayMode === DisplayMode.HEX) {
        const rawBuffers = items.map(i => i.data);
        const newData = concatUint8Arrays(rawBuffers);
        
        // Combine with any previously partial bytes
        const totalData = concatUint8Arrays([hexBuffer.current, newData]);
        
        let currentOffset = 0;
        let output = '';

        // If we previously printed a partial line, verify cursor is reset or use CR to overwrite
        if (isHexPartialPrinted.current) {
            output += '\r\x1b[K'; // Move to start of line and clear it
            isHexPartialPrinted.current = false;
        }

        // Process full 16-byte chunks
        while (currentOffset + 16 <= totalData.length) {
            const chunk = totalData.slice(currentOffset, currentOffset + 16);
            output += formatHexDumpLine(hexOffset.current, chunk) + '\r\n';
            hexOffset.current += 16;
            currentOffset += 16;
        }

        // Store remaining bytes that don't make a full line yet
        const remaining = totalData.slice(currentOffset);
        hexBuffer.current = remaining;
        
        // Print partial line if any (without newline, so it can be overwritten next time)
        if (remaining.length > 0) {
            output += formatHexDumpLine(hexOffset.current, remaining);
            isHexPartialPrinted.current = true;
        }

        terminalRef.current.write(output);
        return;
    }

    // --- MODE 3: Text with Timestamp ---
    let buffer = '';
    for (const item of items) {
       const res = formatDataForTextLog(item, showTimestamp, lastCharWasNewline.current);
       lastCharWasNewline.current = res.endsWithNewline;
       buffer += res.text;
    }
    terminalRef.current.write(buffer);
  };

  const repaintTerminal = () => {
    if (!terminalRef.current) return;
    
    terminalRef.current.reset(); // Fully clear xterm
    lastCharWasNewline.current = true; // Reset Text state

    // Reset Hex state
    hexBuffer.current = new Uint8Array(0);
    hexOffset.current = 0;
    isHexPartialPrinted.current = false;

    // Process history in chunks to avoid blocking UI
    const CHUNK_SIZE = 2000;
    for (let i = 0; i < rxHistory.current.length; i += CHUNK_SIZE) {
        const batch = rxHistory.current.slice(i, i + CHUNK_SIZE);
        writeBatchToTerminal(batch, true);
    }
  };

  // --- Effects ---

  // Repaint when display settings change
  useEffect(() => {
    repaintTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode, showTimestamp]);

  // Process incoming data loop (Update UI)
  useEffect(() => {
    const interval = setInterval(() => {
      if (pendingChunks.current.length === 0) return;

      const chunks = pendingChunks.current;
      pendingChunks.current = []; // Clear queue
      
      writeBatchToTerminal(chunks);

    }, 16); // 60 FPS

    return () => clearInterval(interval);
  }, [displayMode, showTimestamp]);

  // --- Resize Observer ---
  useEffect(() => {
    const handleResize = () => {
       setTimeout(() => terminalRef.current?.fit(), 100);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    return () => {
      if (isConnected) disconnectPort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Serial Logic ---

  const readLoop = async (currentPort: SerialPort) => {
    if (!currentPort.readable) return;
    
    const reader = currentPort.readable.getReader();
    readerRef.current = reader;
    keepReading.current = true;

    try {
      while (keepReading.current) {
        const { value, done } = await reader.read();
        if (done) {
          keepReading.current = false;
          break;
        }
        if (value) {
          // Storage & Display
          const item: HistoryItem = {
            timestamp: Date.now(),
            data: value
          };
          rxHistory.current.push(item);
          pendingChunks.current.push(item);
        }
      }
    } catch (error) {
      console.error("Read error:", error);
    } finally {
      reader.releaseLock();
      readerRef.current = null;
    }
  };

  const connectPort = async () => {
    if (!navigator.serial) {
      alert("Web Serial API is not supported in this browser.");
      return;
    }

    try {
      const selectedPort = await navigator.serial.requestPort();
      await selectedPort.open({ 
        baudRate,
        dataBits,
        stopBits,
        parity,
        flowControl 
      });
      
      setPort(selectedPort);
      setIsConnected(true);
      rxHistory.current = [];
      pendingChunks.current = [];
      
      // Reset logic
      lastCharWasNewline.current = true;
      hexBuffer.current = new Uint8Array(0);
      hexOffset.current = 0;
      isHexPartialPrinted.current = false;

      // Initial message
      const msg = `\x1b[32m\r\n--- Connected to ${baudRate} baud ---\x1b[0m\r\n`;
      terminalRef.current?.write(msg);

      readLoop(selectedPort);
      
    } catch (error) {
      console.error("Failed to connect:", error);
      alert(`Failed to connect: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disconnectPort = async () => {
    keepReading.current = false;
    if (readerRef.current) {
      try { await readerRef.current.cancel(); } catch (e) {}
    }
    if (port) {
      try { await port.close(); } catch (e) {}
    }
    setPort(null);
    setIsConnected(false);
    terminalRef.current?.write(`\x1b[31m\r\n--- Disconnected ---\x1b[0m\r\n`);
  };

  const sendData = async (data: Uint8Array, isSilent: boolean = false) => {
    if (!port || !port.writable) {
        if (!isSilent) alert("Port not writable or disconnected.");
        return;
    }
    if (port.writable.locked) return; 

    const writer = port.writable.getWriter();
    writerRef.current = writer;
    try {
        await writer.write(data);
    } catch (err) {
        console.error("Write error:", err);
    } finally {
        writer.releaseLock();
        writerRef.current = null;
    }
  };

  const cancelTx = () => {
    isTxCancelled.current = true;
  };

  const sendLargeData = async (data: Uint8Array) => {
    if (!port || !port.writable) return;
    if (writerRef.current) return;

    const writer = port.writable.getWriter();
    writerRef.current = writer;

    // Rate limiting calculation
    const CHUNK_SIZE = 2048; // Smaller chunks for stability
    const bitsPerByte = 10; 
    // Calculate time needed to transmit one chunk in ms
    const msPerChunk = ((CHUNK_SIZE * bitsPerByte) / baudRate) * 1000;
    
    // We add a small safety factor (1.1x) to ensure buffer doesn't overflow
    const safeDelay = Math.ceil(msPerChunk * 1.1);

    const totalSize = data.length;
    let sentBytes = 0;
    setTxProgress(0);
    isTxCancelled.current = false;

    try {
      for (let i = 0; i < totalSize; i += CHUNK_SIZE) {
          if (isTxCancelled.current) {
             terminalRef.current?.write(`\r\n\x1b[31m[System] Transmission cancelled by user. (${sentBytes} / ${totalSize} bytes sent)\x1b[0m\r\n`);
             break;
          }

          const chunk = data.slice(i, Math.min(i + CHUNK_SIZE, totalSize));
          
          const start = performance.now();
          await writer.write(chunk);
          
          sentBytes += chunk.length;
          setTxProgress(Math.floor((sentBytes / totalSize) * 100));

          // Wait for the line to clear
          const elapsed = performance.now() - start;
          if (elapsed < safeDelay) {
             await new Promise(resolve => setTimeout(resolve, safeDelay - elapsed));
          } else {
             await new Promise(resolve => setTimeout(resolve, 0));
          }
      }
      if (!isTxCancelled.current) {
          terminalRef.current?.write(`\r\n\x1b[33m[System] Sent ${totalSize} bytes.\x1b[0m\r\n`);
      }
    } catch (e) {
      console.error(e);
      terminalRef.current?.write(`\r\n\x1b[31m[Error] Send failed.\x1b[0m\r\n`);
    } finally {
      writer.releaseLock();
      writerRef.current = null;
      setTxProgress(null);
      setTxFileName('');
      isTxCancelled.current = false;
    }
  };

  const handleTerminalInput = useCallback((data: string) => {
    if (!isConnected) return;
    const payload = new TextEncoder().encode(data);
    sendData(payload, true);
  }, [isConnected]);

  const handleManualSend = () => {
    let payload: Uint8Array | null = null;

    if (bottomInputMode === SendMode.TEXT) {
      let processedText = bottomInputText.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
      if (addCRLF) processedText += '\r\n';
      
      if (processedText.length === 0) return;
      payload = new TextEncoder().encode(processedText);
    } else {
      const raw = hexStringToBuffer(bottomInputText);
      // If conversion failed
      if (!raw) {
          if (bottomInputText.trim().length > 0) alert("Invalid Hex format.");
          return;
      }
      
      // Handle CRLF for Hex: append 0x0D 0x0A
      if (addCRLF) {
          const joined = new Uint8Array(raw.length + 2);
          joined.set(raw);
          joined.set([0x0D, 0x0A], raw.length);
          payload = joined;
      } else {
          payload = raw;
      }
      
      if (payload.length === 0) return;
    }

    if (payload) {
        setTxFileName('Manual Input');
        if (payload.length > 1024) {
            sendLargeData(payload);
        } else {
            sendData(payload);
        }
        setBottomInputText('');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setTxFileName(file.name);

    const reader = new FileReader();
    reader.onload = (evt) => {
        if (evt.target?.result instanceof ArrayBuffer) {
            const data = new Uint8Array(evt.target.result);
            sendLargeData(data);
        }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const downloadLogs = () => {
    if (rxHistory.current.length === 0) {
      alert("No received data to save.");
      return;
    }

    let blobParts: BlobPart[] = [];
    let filename = '';
    let mimeType = '';

    if (displayMode === DisplayMode.HEX) {
        // Binary Save (Raw bytes)
        for (const item of rxHistory.current) {
            // Fix: cast to any to avoid strict typescript check failure for ArrayBufferLike vs ArrayBuffer
            blobParts.push(item.data as any);
        }
        filename = `serial_dump_${new Date().toISOString().replace(/[:.]/g, '-')}.bin`;
        mimeType = 'application/octet-stream';
    } else {
        // Text Log Save (Uses the formatted text logic)
        let tempNewlineState = true;
        for (const item of rxHistory.current) {
            const res = formatDataForTextLog(item, showTimestamp, tempNewlineState);
            tempNewlineState = res.endsWithNewline;
            blobParts.push(res.text);
        }
        const ext = 'log';
        filename = `serial_log_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        mimeType = 'text/plain';
    }

    downloadBlob(blobParts, filename, mimeType);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-200 font-sans">
      {/* Header & Config */}
      <header className="bg-gray-900 border-b border-gray-800">
          <div className="px-4 py-2 flex items-center justify-between">
            <h1 className="text-lg font-bold text-white flex items-center gap-2 overflow-hidden">
                <svg className="w-14 h-14 text-blue-500 -my-3 mr-2" viewBox="0 0 1024 1024" fill="currentColor">
                    <path d="M578.4 309c-5 2-5.4 4-5.4 25.2V354h114.1l-.3-20.1-.3-20.1-3.3-2.9-3.2-2.9-49.8.1c-27.3 0-50.7.4-51.8.9m19.4 17.9c.9.5 1.2 2.8 1 7.7-.3 6.8-.3 6.9-3.3 7.2-1.9.3-3.3-.2-4.2-1.4-1.6-2.2-1.7-11.6-.1-13.2 1.4-1.4 4.7-1.6 6.6-.3m35 .3c.7.7 1.2 3.7 1.2 6.8 0 6-1.1 8-4.5 8s-4.5-2-4.5-8 1.1-8 4.5-8c1.2 0 2.6.5 3.3 1.2m35 0c.7.7 1.2 3.7 1.2 6.8 0 6-1.1 8-4.5 8s-4.5-2-4.5-8 1.1-8 4.5-8c1.2 0 2.6.5 3.3 1.2"/>
                    <path d="M548 336c-1.7 1.7-2 3.3-2 12.5V359l-3.4 1.4c-7 2.9-6.6-1.7-6.6 76.4 0 64.5.1 70.5 1.7 72.9 3 4.5 6.7 5.3 24.6 5.3h16.5l7.8 19 7.9 19h70.2l7.9-19 7.8-19H697c18.9 0 22.2-.9 25.2-7 1.7-3.2 1.8-8.7 1.8-71 0-75.7.3-72.5-7.2-76.5l-3.8-2v-10.3c0-8.9-.3-10.5-2-12.2-2.5-2.5-5.2-2.6-7.3-.2-1.4 1.5-1.7 4-1.7 12.5V359H557v-10.8c0-9.3-.3-11.1-1.8-12.5-2.5-2.2-4.8-2.1-7.2.3m126.4 69.2c1.4 1.9 1.6 6.2 1.6 27 0 23.5-.1 24.9-2 26.8s-3.3 2-44.1 2c-27.1 0-42.7-.4-44-1-1.8-1-1.9-2.4-1.9-27.8 0-19.5.3-27.1 1.2-28s12.1-1.2 44.4-1.2h43.3z"/>
                    <path d="M593 431.5V451h73v-39h-73zm-302.8-1.6c-7 2.4-11.8 6.5-15.6 13.1l-3.1 5.5v72l3.1 5.5c3.7 6.6 9.7 11.4 16.6 13.5 7.7 2.3 196.8 2.3 204.5 0 6.8-2 14.3-8.8 17.4-15.7 2.4-5.3 2.4-5.6 2.4-39.3 0-33.6 0-34.1-2.4-39.2-2.6-5.8-9-12.3-14.8-15-3.6-1.7-10-1.8-103.3-2-94.4-.2-99.8-.2-104.8 1.6m157.1 18.2c4.7 1.3 10.2 6 12.8 11 1.7 3.4 1.9 6 1.9 25.5 0 24.3-.3 25.8-7 31.8-2.1 1.9-5.6 3.9-7.7 4.5-5.5 1.5-103.8 1.5-108.4 0-5.1-1.8-9.7-5.5-12.2-10.2-2-3.9-2.2-5.8-2.5-23.8-.5-26.6 1.2-31.8 11.7-37.2l5.5-2.7h51c32.6 0 52.5.4 54.9 1.1m-139.1 19c10.5 6 10.8 6.4 10.8 17.1 0 4.9-.4 9.7-.9 10.7-1.2 2.1-16.3 11.1-18.7 11.1-1.9 0-17.5-8.7-18.6-10.4-.4-.6-.8-5.6-.8-11.1s.4-10.5.8-11.1c1.1-1.7 16.5-10.4 18.4-10.4.9 0 4.9 1.9 9 4.1m188 0c10.5 6 10.8 6.4 10.8 17.1 0 4.9-.4 9.7-.9 10.7-1.2 2.1-16.3 11.1-18.7 11.1-1.9 0-17.5-8.7-18.6-10.4-.4-.6-.8-5.6-.8-11.2 0-8.4.3-10.3 1.8-11.6 3.1-2.7 15.7-9.8 17.4-9.8.9 0 4.9 1.9 9 4.1"/>
                    <path d="M342.3 456.7c-1.3.2-3.6 1.8-5.2 3.4-3.8 3.7-4.4 8.7-3.9 29.1.3 13.1.6 15.7 2.3 18.2 3.7 5.6 4.1 5.6 57.5 5.6 52.4 0 53.1-.1 57.5-5 1.9-2.1 2-3.6 2-23.5s-.1-21.4-2-23.5c-4.4-5-5.1-5-57.2-4.9-26.8.1-49.8.4-51 .6m8.5 18.9c.4 3.8-1.8 5.9-5.2 5-3-.7-4.1-3.7-2.6-6.6.9-1.6 1.9-2 4.3-1.8 2.8.3 3.2.7 3.5 3.4m23.2-2c1 1.1 1.1 2.3.4 4.2-1.7 4.8-8.4 3.8-8.4-1.2 0-4.3 5.3-6.3 8-3m22.8 1.7c.4 3.7-1.5 5.9-4.7 5.5-1.7-.2-2.9-1.2-3.5-3-1.3-3.7.7-6 4.8-5.6 2.6.2 3.2.8 3.4 3.1m23.2-1.7c1 1.1 1.1 2.3.4 4.2-1.7 4.8-8.4 3.8-8.4-1.2 0-4.3 5.3-6.3 8-3m22.8-.4c3 3 .3 8.2-4 7.6-2.9-.4-4.7-5-2.8-7.2 1.5-1.9 5.1-2.1 6.8-.4m-80 16c.7.7 1.2 2.1 1.2 3.3s-.5 2.6-1.2 3.3-2.1 1.2-3.3 1.2-2.6-.5-3.3-1.2-1.2-2.1-1.2-3.3.5-2.6 1.2-3.3 2.1-1.2 3.3-1.2 2.6.5 3.3 1.2m23.6.4c3.2 3.1.7 7.8-3.8 7.2-3.6-.4-5.1-3.7-3-6.7 1.8-2.5 4.6-2.7 6.8-.5m22.4-.4c.7.7 1.2 2.1 1.2 3.3s-.5 2.6-1.2 3.3-2.1 1.2-3.3 1.2-2.6-.5-3.3-1.2-1.2-2.1-1.2-3.3.5-2.6 1.2-3.3 2.1-1.2 3.3-1.2 2.6.5 3.3 1.2m23.7 1.2c2.3 3.4.5 6.6-3.5 6.6s-5.8-3.2-3.5-6.6c.8-1.3 2.4-2.4 3.5-2.4s2.7 1.1 3.5 2.4m-138.7-14.6-4.8 2.7v12.1l5.3 2.8 5.2 2.8 4.8-2.7 4.7-2.7v-12.5l-4.9-2.6c-2.7-1.5-5-2.7-5.2-2.6-.2 0-2.5 1.2-5.1 2.7m188 0-4.8 2.7v12l5.3 2.8 5.2 2.8 4.8-2.6 4.7-2.7v-12.3l-4.5-2.8c-2.5-1.5-4.9-2.7-5.3-2.6-.4 0-2.8 1.2-5.4 2.7m65.2 65.6c0 11.7.3 22.8.6 24.5l.7 3.1H561c12.4 0 12.8-.1 13.4-2.3.3-1.2.6-12.2.6-24.5V520h-28zm137.3-4.2c.4 9.5.7 20.6.7 24.5v7.3h27v-49h-28.3zM594 561.5v3.5h71v-7h-71zm0 19v5.5h71v-11h-71zm.7 15.2c-.4.3-.7 3.3-.7 6.5v5.8h71v-13h-34.8c-19.2 0-35.2.3-35.5.7m136 13c-.4.3-.7 16.1-.7 34.9 0 21.8-.4 35.3-1.1 37.1-1.4 3.8-5.6 8.1-10.1 10.4-3.4 1.7-6.2 1.9-33 1.9-28.5 0-29.5-.1-33.8-2.3-2.6-1.3-5.7-4-7.5-6.5l-3-4.4-.3-32.9-.3-32.9H618v29.7c0 16.4.4 32.4 1 35.7 2.8 17.5 16.4 31.8 33.8 35.5 3.2.7 16.2 1.1 33 1.1 36.1 0 41.6-1.2 53-11.5 6.1-5.5 9.7-11.2 12.3-19.6 1.7-5.5 1.9-9.6 1.9-41.5V608h-10.8c-6 0-11.2.3-11.5.7"/>
                </svg>
                Web Serial Studio
            </h1>
            <a 
              href="https://github.com/YangGangUEFI/web-serial-studio" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-white transition-colors"
              title="View on GitHub"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
            </a>
          </div>
          <ConfigPanel 
            isConnected={isConnected}
            baudRate={baudRate}
            setBaudRate={setBaudRate}
            dataBits={dataBits}
            setDataBits={setDataBits}
            stopBits={stopBits}
            setStopBits={setStopBits}
            parity={parity}
            setParity={setParity}
            flowControl={flowControl}
            setFlowControl={setFlowControl}
            onConnect={connectPort}
            onDisconnect={disconnectPort}
          />
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden relative">
        
        <div className="flex-1 flex flex-col min-w-0 relative">
            {/* Toolbar */}
            <div className="bg-gray-900 p-2 flex items-center gap-3 border-b border-gray-800 text-sm overflow-x-auto">
                <span className="text-gray-400 font-bold px-2 whitespace-nowrap">Display:</span>
                <div className="flex bg-gray-800 rounded p-1 whitespace-nowrap">
                    <button 
                        onClick={() => setDisplayMode(DisplayMode.TEXT)}
                        className={`px-3 py-1 rounded text-xs font-medium transition-all ${displayMode === DisplayMode.TEXT ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                    >
                        Text
                    </button>
                    <button 
                        onClick={() => setDisplayMode(DisplayMode.HEX)}
                        className={`px-3 py-1 rounded text-xs font-medium transition-all ${displayMode === DisplayMode.HEX ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                    >
                        Hex
                    </button>
                </div>

                <div className="w-px h-6 bg-gray-700 mx-2"></div>

                <label className="flex items-center gap-2 cursor-pointer hover:text-white text-gray-300 select-none whitespace-nowrap">
                  <input 
                    type="checkbox" 
                    checked={showTimestamp} 
                    onChange={(e) => setShowTimestamp(e.target.checked)}
                    className="rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-xs font-medium">Show Timestamp</span>
                </label>

                <div className="flex-grow"></div>

                <Button variant="secondary" onClick={() => {
                  rxHistory.current = [];
                  lastCharWasNewline.current = true;
                  terminalRef.current?.reset();
                  // Also reset hex state
                  hexBuffer.current = new Uint8Array(0);
                  hexOffset.current = 0;
                  isHexPartialPrinted.current = false;
                }} className="text-xs py-1 h-8 whitespace-nowrap">
                    Clear Screen
                </Button>
                <Button variant="secondary" onClick={downloadLogs} className="text-xs py-1 h-8 flex items-center gap-1 whitespace-nowrap">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    Save
                </Button>
            </div>

            {/* Terminal Area */}
            <div className="flex-1 bg-black p-1 overflow-hidden relative">
                <TerminalView 
                    ref={terminalRef} 
                    onInput={handleTerminalInput}
                />
            </div>

            {/* Progress Overlay */}
            {txProgress !== null && (
                <div className="absolute top-12 right-4 bg-gray-800 border border-gray-700 rounded p-3 shadow-lg flex flex-col gap-2 w-64 z-50">
                    <div className="flex justify-between items-center text-xs text-gray-300 mb-1">
                        <div className="flex flex-col overflow-hidden mr-2">
                            <span className="font-bold">Transmitting...</span>
                            {txFileName && <span className="text-gray-500 text-[10px] truncate block" title={txFileName}>{txFileName}</span>}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <span>{txProgress}%</span>
                            <button 
                                onClick={cancelTx} 
                                className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors focus:outline-none"
                                title="Cancel Transmission"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-2">
                        <div className="bg-blue-500 h-2 rounded-full transition-all duration-200" style={{ width: `${txProgress}%` }}></div>
                    </div>
                </div>
            )}
        </div>
      </div>
      
      {/* Bottom Panel */}
      <div className="bg-gray-900 border-t border-gray-800 p-2">
        <div className="flex items-center gap-4 max-w-full">
            <div className="flex-1 flex gap-2 items-center">
                <select 
                  className="bg-gray-800 text-gray-300 text-xs border border-gray-700 rounded px-2 h-8 focus:ring-1 focus:ring-blue-500 outline-none"
                  value={bottomInputMode}
                  onChange={(e) => setBottomInputMode(e.target.value as SendMode)}
                >
                  <option value={SendMode.TEXT}>Text Line</option>
                  <option value={SendMode.HEX}>Hex String</option>
                </select>
                <input 
                  type="text" 
                  value={bottomInputText}
                  onChange={(e) => setBottomInputText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleManualSend()}
                  placeholder={bottomInputMode === SendMode.TEXT ? "Send text line (Enter)..." : "AA BB 01 02..."}
                  className="flex-1 bg-gray-950 text-white text-sm border border-gray-700 rounded px-3 py-1 h-8 focus:ring-1 focus:ring-blue-500 outline-none font-mono"
                />
                
                <label className="flex items-center gap-1 cursor-pointer hover:text-white text-gray-300 select-none whitespace-nowrap text-xs mx-1">
                  <input 
                    type="checkbox" 
                    checked={addCRLF} 
                    onChange={(e) => setAddCRLF(e.target.checked)}
                    className="rounded bg-gray-800 border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span>\r\n</span>
                </label>

                <Button onClick={handleManualSend} disabled={!isConnected} className="h-8 text-xs py-0">
                  Send
                </Button>
            </div>

            <div className="flex items-center gap-2 pl-4 border-l border-gray-700">
                 <input 
                        type="file" 
                        id="fileUpload" 
                        className="hidden" 
                        onChange={handleFileUpload}
                        disabled={!isConnected || txProgress !== null}
                    />
                    <label 
                        htmlFor="fileUpload" 
                        className={`flex items-center justify-center px-3 py-1 h-8 rounded border border-dashed cursor-pointer transition-colors text-xs
                            ${isConnected && txProgress === null
                                ? 'border-gray-600 hover:border-gray-400 hover:bg-gray-800 text-gray-300' 
                                : 'border-gray-800 text-gray-600 cursor-not-allowed'}`}
                    >
                        <svg className="w-3 h-3 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                        Send File
                    </label>
            </div>
        </div>
      </div>
    </div>
  );
};

export default App;
