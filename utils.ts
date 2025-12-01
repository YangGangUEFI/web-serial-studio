

export const bufferToHex = (buffer: Uint8Array): string => {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
};

export const hexStringToBuffer = (hexString: string): Uint8Array | null => {
  // Remove spaces, 0x, commas, etc.
  const cleanHex = hexString.replace(/[\s,0x]/g, '');
  if (cleanHex.length % 2 !== 0) return null; // Invalid length

  try {
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
    }
    return bytes;
  } catch (e) {
    return null;
  }
};

export const concatUint8Arrays = (arrays: Uint8Array[]): Uint8Array => {
  const totalLength = arrays.reduce((acc, val) => acc + val.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};

export const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `[${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}]`;
};

export const formatHexDumpLine = (offset: number, data: Uint8Array): string => {
  const address = offset.toString(16).padStart(8, '0');
  
  const hexPart = Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  
  // 3 chars per byte (2 digits + 1 space)
  const padding = '   '.repeat(16 - data.length); 
  
  const asciiPart = Array.from(data)
    .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
    .join('');
    
  return `${address}  ${hexPart}${padding}  |${asciiPart}|`;
};

export const downloadBlob = async (content: BlobPart[], filename: string, contentType: string) => {
  const blob = new Blob(content, { type: contentType });

  // Use modern File System Access API if available for "Save As" dialog
  if ('showSaveFilePicker' in window) {
    try {
      const extension = filename.split('.').pop();
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Serial Dump',
          accept: { [contentType]: [`.${extension}`] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // If user aborts, do nothing. If error, fall back.
      if ((err as any).name === 'AbortError') return;
    }
  }

  // Fallback
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
