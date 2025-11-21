import React from 'react';
import { Button } from './Button';
import { ParityType, FlowControlType } from '../types';

interface ConfigPanelProps {
  isConnected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  baudRate: number;
  setBaudRate: (rate: number) => void;
  dataBits: number;
  setDataBits: (bits: number) => void;
  stopBits: number;
  setStopBits: (bits: number) => void;
  parity: ParityType;
  setParity: (parity: ParityType) => void;
  flowControl: FlowControlType;
  setFlowControl: (fc: FlowControlType) => void;
}

const BAUD_RATES = [
  110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 128000, 256000, 921600
];

const Select: React.FC<{
  label: string;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  disabled: boolean;
  children: React.ReactNode;
}> = ({ label, value, onChange, disabled, children }) => (
  <div className="flex flex-col gap-1">
    <label className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">{label}</label>
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="bg-gray-900 border border-gray-700 text-white text-sm rounded px-2 py-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 h-8"
    >
      {children}
    </select>
  </div>
);

export const ConfigPanel: React.FC<ConfigPanelProps> = ({
  isConnected,
  onConnect,
  onDisconnect,
  baudRate,
  setBaudRate,
  dataBits,
  setDataBits,
  stopBits,
  setStopBits,
  parity,
  setParity,
  flowControl,
  setFlowControl
}) => {
  return (
    <div className="bg-gray-800 p-3 border-b border-gray-700 flex flex-wrap items-end gap-3 shadow-md z-10">
      
      <Select 
        label="Baud Rate" 
        value={baudRate} 
        onChange={(e) => setBaudRate(Number(e.target.value))} 
        disabled={isConnected}
      >
        {BAUD_RATES.map(rate => <option key={rate} value={rate}>{rate}</option>)}
      </Select>

      <Select 
        label="Data Bits" 
        value={dataBits} 
        onChange={(e) => setDataBits(Number(e.target.value))} 
        disabled={isConnected}
      >
        <option value={7}>7</option>
        <option value={8}>8</option>
      </Select>

      <Select 
        label="Stop Bits" 
        value={stopBits} 
        onChange={(e) => setStopBits(Number(e.target.value))} 
        disabled={isConnected}
      >
        <option value={1}>1</option>
        <option value={2}>2</option>
      </Select>

      <Select 
        label="Parity" 
        value={parity} 
        onChange={(e) => setParity(e.target.value as ParityType)} 
        disabled={isConnected}
      >
        <option value="none">None</option>
        <option value="even">Even</option>
        <option value="odd">Odd</option>
      </Select>

      <Select 
        label="Flow Control" 
        value={flowControl} 
        onChange={(e) => setFlowControl(e.target.value as FlowControlType)} 
        disabled={isConnected}
      >
        <option value="none">None</option>
        <option value="hardware">Hardware</option>
      </Select>

      <div className="flex-grow"></div>

      <div className="flex items-center gap-3 mb-0.5">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold ${isConnected ? 'bg-green-900/30 text-green-400 border border-green-800' : 'bg-red-900/30 text-red-400 border border-red-800'}`}>
          <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
          {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
        </div>

        {!isConnected ? (
          <Button onClick={onConnect} variant="primary" className="h-9">
            Connect Port
          </Button>
        ) : (
          <Button onClick={onDisconnect} variant="danger" className="h-9">
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
};