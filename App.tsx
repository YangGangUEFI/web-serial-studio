
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConfigPanel } from './components/ConfigPanel';
import { Button } from './components/Button';
import { TerminalView, TerminalRef } from './components/TerminalView';
import { SerialPort, DisplayMode, SendMode, ParityType, FlowControlType } from './types';
import { bufferToHex, hexStringToBuffer, downloadBlob, formatTimestamp } from './utils';

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
  // We need to know if the last character printed was a newline to prepend a timestamp
  const lastCharWasNewline = useRef(true);

  // --- Helpers ---

  const formatDataForDisplay = (item: HistoryItem, mode: DisplayMode, withTime: boolean, isNewLineStart: boolean): { text: string, endsWithNewline: boolean } => {
    const tsString = withTime ? `\x1b[32m${formatTimestamp(item.timestamp)}\x1b[0m ` : '';
    
    if (mode === DisplayMode.HEX) {
      // Hex mode: Just prepend timestamp to the block
      const hex = bufferToHex(item.data);
      return { 
        text: `${tsString}${hex} `, 
        endsWithNewline: false // Hex view is continuous blocks usually, or we can force newlines. Let's keep it stream-like but separated by spaces.
      };
    } else {
      // Text mode: Handle newlines for timestamps
      let textStr = new TextDecoder().decode(item.data);
      
      if (withTime) {
        // If we are at the start of a line, prepend timestamp
        let formatted = '';
        if (isNewLineStart) {
          formatted += tsString;
        }
        // Inject timestamp after every newline
        // We use a regex to replace \n with \n[TIMESTAMP]
        // Note: Serial often sends \r\n. We target \n.
        formatted += textStr.replace(/\n/g, `\n${tsString}`);
        
        // Check if the *last* character of this chunk is a newline
        // This determines if the *next* chunk should start with a timestamp
        const endsWithNL = textStr.endsWith('\n');
        
        return { text: formatted, endsWithNewline: endsWithNL };
      }
      
      return { text: textStr, endsWithNewline: textStr.endsWith('\n') };
    }
  };

  const repaintTerminal = () => {
    if (!terminalRef.current) return;
    
    terminalRef.current.reset(); // Fully clear xterm
    lastCharWasNewline.current = true; // Reset state

    // Replay entire history
    let buffer = '';
    const CHUNK_LIMIT = 100000; // Flush every 100k chars

    for (const item of rxHistory.current) {
      const res = formatDataForDisplay(item, displayMode, showTimestamp, lastCharWasNewline.current);
      lastCharWasNewline.current = res.endsWithNewline;
      buffer += res.text;

      if (buffer.length > CHUNK_LIMIT) {
        terminalRef.current.write(buffer);
        buffer = '';
      }
    }
    if (buffer.length > 0) {
      terminalRef.current.write(buffer);
    }
  };

  // --- Effects ---

  // Repaint when display settings change
  useEffect(() => {
    repaintTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode, showTimestamp]);

  // Process incoming data loop
  useEffect(() => {
    const interval = setInterval(() => {
      if (pendingChunks.current.length === 0) return;

      const chunks = pendingChunks.current;
      pendingChunks.current = []; // Clear queue

      if (terminalRef.current) {
        let buffer = '';
        for (const item of chunks) {
           const res = formatDataForDisplay(item, displayMode, showTimestamp, lastCharWasNewline.current);
           lastCharWasNewline.current = res.endsWithNewline;
           buffer += res.text;
        }
        terminalRef.current.write(buffer);
      }
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
      lastCharWasNewline.current = true;

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
    if (!bottomInputText) return;
    let payload: Uint8Array | null = null;

    if (bottomInputMode === SendMode.TEXT) {
      const processedText = bottomInputText.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
      payload = new TextEncoder().encode(processedText);
    } else {
      payload = hexStringToBuffer(bottomInputText);
      if (!payload) {
        alert("Invalid Hex format.");
        return;
      }
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
        // Text Log Save
        let tempNewlineState = true;
        for (const item of rxHistory.current) {
            const res = formatDataForDisplay(item, displayMode, showTimestamp, tempNewlineState);
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
          <div className="px-4 py-2">
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
                <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                Web Serial Studio
            </h1>
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
            <div className="bg-gray-900 p-2 flex items-center gap-3 border-b border-gray-800 text-sm">
                <span className="text-gray-400 font-bold px-2">Display:</span>
                <div className="flex bg-gray-800 rounded p-1">
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

                <label className="flex items-center gap-2 cursor-pointer hover:text-white text-gray-300 select-none">
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
                }} className="text-xs py-1 h-8">
                    Clear Screen
                </Button>
                <Button variant="secondary" onClick={downloadLogs} className="text-xs py-1 h-8 flex items-center gap-1">
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
            <div className="flex-1 flex gap-2">
                <select 
                  className="bg-gray-800 text-gray-300 text-xs border border-gray-700 rounded px-2 focus:ring-1 focus:ring-blue-500 outline-none"
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
                  className="flex-1 bg-gray-950 text-white text-sm border border-gray-700 rounded px-3 py-1 focus:ring-1 focus:ring-blue-500 outline-none font-mono"
                />
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
