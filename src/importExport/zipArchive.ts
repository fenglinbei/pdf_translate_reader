type StoredZipEntryInput = {
  data: Blob | string | Uint8Array;
  name: string;
};

type StoredZipEntry = {
  crc32: number;
  data: Uint8Array;
  dosDate: number;
  dosTime: number;
  name: string;
  nameBytes: Uint8Array;
  offset: number;
};

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const MAX_COMMENT_SEARCH = 0xffff + 22;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const crc32Table = createCrc32Table();

export async function createStoredZip(entries: StoredZipEntryInput[]) {
  const storedEntries: StoredZipEntry[] = [];
  let offset = 0;

  for (const input of entries) {
    const data = await toUint8Array(input.data);
    const nameBytes = textEncoder.encode(input.name);
    const { dosDate, dosTime } = dateToDosDateTime(new Date());

    if (nameBytes.length > 0xffff) {
      throw new Error("Archive entry name is too long.");
    }

    if (data.byteLength > 0xffffffff) {
      throw new Error("Archive entry is too large.");
    }

    storedEntries.push({
      crc32: computeCrc32(data),
      data,
      dosDate,
      dosTime,
      name: input.name,
      nameBytes,
      offset,
    });
    offset += 30 + nameBytes.byteLength + data.byteLength;
  }

  const localParts = storedEntries.flatMap((entry) => [
    createLocalFileHeader(entry),
    entry.nameBytes,
    entry.data,
  ]);
  const centralDirectoryOffset = offset;
  const centralParts = storedEntries.flatMap((entry) => [
    createCentralDirectoryHeader(entry),
    entry.nameBytes,
  ]);
  const centralDirectorySize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const endRecord = createEndOfCentralDirectoryRecord({
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount: storedEntries.length,
  });

  return new Blob([...localParts, ...centralParts, endRecord], {
    type: "application/zip",
  });
}

export async function readStoredZip(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, Uint8Array>();
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("The reading package is not a valid ZIP archive.");
    }

    const method = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = textDecoder.decode(bytes.slice(nameStart, nameStart + fileNameLength));

    if (method !== STORE_METHOD) {
      throw new Error("This reading package uses ZIP compression that is not supported yet.");
    }

    if (compressedSize !== uncompressedSize) {
      throw new Error("The reading package contains an invalid stored entry.");
    }

    const data = readLocalEntryData({
      bytes,
      compressedSize,
      localHeaderOffset,
      view,
    });

    if (computeCrc32(data) !== crc32) {
      throw new Error(`The reading package entry "${name}" is corrupted.`);
    }

    entries.set(name, data);
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

export function decodeUtf8(bytes: Uint8Array) {
  return textDecoder.decode(bytes);
}

function createLocalFileHeader(entry: StoredZipEntry) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORE_METHOD, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.data.byteLength, true);
  view.setUint32(22, entry.data.byteLength, true);
  view.setUint16(26, entry.nameBytes.byteLength, true);
  view.setUint16(28, 0, true);

  return bytes;
}

function createCentralDirectoryHeader(entry: StoredZipEntry) {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORE_METHOD, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.data.byteLength, true);
  view.setUint32(24, entry.data.byteLength, true);
  view.setUint16(28, entry.nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.offset, true);

  return bytes;
}

function createEndOfCentralDirectoryRecord({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}: {
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
}) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);

  if (entryCount > 0xffff) {
    throw new Error("Archive contains too many entries.");
  }

  view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectorySize, true);
  view.setUint32(16, centralDirectoryOffset, true);
  view.setUint16(20, 0, true);

  return bytes;
}

function readLocalEntryData({
  bytes,
  compressedSize,
  localHeaderOffset,
  view,
}: {
  bytes: Uint8Array;
  compressedSize: number;
  localHeaderOffset: number;
  view: DataView;
}) {
  if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error("The reading package has a broken ZIP entry.");
  }

  const fileNameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + compressedSize;

  if (dataEnd > bytes.byteLength) {
    throw new Error("The reading package entry is truncated.");
  }

  return bytes.slice(dataStart, dataEnd);
}

function findEndOfCentralDirectory(view: DataView) {
  const minOffset = Math.max(0, view.byteLength - MAX_COMMENT_SEARCH);

  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }

  throw new Error("The reading package is not a valid ZIP archive.");
}

async function toUint8Array(data: Blob | string | Uint8Array) {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (typeof data === "string") {
    return textEncoder.encode(data);
  }

  return new Uint8Array(await data.arrayBuffer());
}

function dateToDosDateTime(date: Date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | seconds,
  };
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

function computeCrc32(data: Uint8Array) {
  let value = 0xffffffff;

  for (const byte of data) {
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}
