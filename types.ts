
// Web Serial API Types (Partial definition since it's not in all TS envs yet)
export interface SerialPort {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): Partial<SerialPortInfo>;
}

export interface SerialPortInfo {
  usbVendorId: number;
  usbProductId: number;
}

export type ParityType = 'none' | 'even' | 'odd';
export type FlowControlType = 'none' | 'hardware';

export interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: ParityType;
  bufferSize?: number;
  flowControl?: FlowControlType;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  data: Uint8Array;
  direction: 'rx' | 'tx';
}

export enum DisplayMode {
  TEXT = 'TEXT',
  HEX = 'HEX',
}

export enum SendMode {
  TEXT = 'TEXT',
  HEX = 'HEX',
}

// Xterm.js Global Type Definitions (Shim)
declare global {
  class Terminal {
    constructor(options?: any);
    open(element: HTMLElement): void;
    write(data: string | Uint8Array): void;
    clear(): void;
    reset(): void;
    dispose(): void;
    onData(callback: (data: string) => void): void;
    loadAddon(addon: any): void;
    options: any;
    focus(): void;
    attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean): void;
  }
  
  // fit-addon might be exposed as a class or an object containing the class depending on the build
  var FitAddon: any;
}
