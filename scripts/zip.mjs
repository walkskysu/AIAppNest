import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createDeflateRaw, crc32 } from 'node:zlib';

// Stream ZIP32 with UTF-8 names using only the pinned Node runtime. Bound sizes
// explicitly: the .NET installer reads these archives without external tools.
export async function createArchive(source, destination) {
  const file = await open(destination, 'wx'), central = [];
  let offset = 0;
  const append = async bytes => { await file.writeFile(bytes); offset += bytes.length; if (offset > 0xffffffff) throw Error('ZIP64_REQUIRED'); };
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error('LINKED_ARCHIVE_INPUT');
      if (entry.isDirectory()) { await walk(path, name + '/'); continue; }
      if (!entry.isFile()) throw Error('INVALID_ARCHIVE_INPUT');
      const bytes = Buffer.from(name), start = offset;
      if (bytes.length > 65535 || (await stat(path)).size > 0xffffffff) throw Error('ZIP64_REQUIRED');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x808, 6); header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12); // 1980-01-01; timestamps are not release identity.
      header.writeUInt16LE(bytes.length, 26);
      await append(header); await append(bytes);
      let checksum = 0, size = 0;
      const input = Readable.from((async function* () {
        for await (const chunk of createReadStream(path)) { checksum = crc32(chunk, checksum); size += chunk.length; yield chunk; }
      })());
      const compressor = createDeflateRaw(); input.on('error', error => compressor.destroy(error)); input.pipe(compressor);
      const dataStart = offset;
      try { for await (const chunk of compressor) await append(chunk); }
      finally { input.destroy(); compressor.destroy(); }
      const compressed = offset - dataStart;
      if (size > 0xffffffff) throw Error('ZIP64_REQUIRED');
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12);
      await append(descriptor);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x808, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
      record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed, 20); record.writeUInt32LE(size, 24);
      record.writeUInt16LE(bytes.length, 28); record.writeUInt32LE(start, 42);
      central.push(Buffer.concat([record, bytes]));
      if (central.length > 65535) throw Error('ZIP64_REQUIRED');
    }
  }
  try {
    await walk(source);
    const start = offset;
    for (const record of central) await append(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await append(end); await file.sync();
  } finally { await file.close(); }
}
