/** Validate bounded raster containers before storage; preview still handles decoder/network failures. */
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function completePng(bytes: Buffer): boolean {
  let offset = 8;
  let header = false;
  let image = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > bytes.length) return false;
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      return false;
    if (!header) {
      if (
        kind !== 'IHDR' ||
        size !== 13 ||
        !bytes.readUInt32BE(offset + 8) ||
        !bytes.readUInt32BE(offset + 12)
      )
        return false;
      header = true;
    } else if (kind === 'IHDR') return false;
    if (kind === 'IDAT' && size) image = true;
    if (kind === 'IEND')
      return header && image && size === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}
// Follow every scan's stuffed/restart bytes and subsequent markers (including progressive JPEG).
function completeJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  let offset = 2;
  let frame = false;
  let scan = false;
  let entropy = false;
  while (offset < bytes.length) {
    if (entropy) {
      let data = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) {
          data = true;
          offset++;
          continue;
        }
        const start = offset++;
        while (bytes[offset] === 255) offset++;
        if (offset >= bytes.length) return false;
        const marker = bytes[offset];
        if (marker === 0 || (marker >= 208 && marker <= 215)) {
          if (marker === 0) data = true;
          offset++;
          continue;
        }
        offset = start;
        break;
      }
      if (!data) return false;
      entropy = false;
    }
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) return frame && scan && offset === bytes.length;
    if (marker === 1) continue;
    if (
      marker === 0 ||
      marker === 216 ||
      (marker >= 208 && marker <= 215) ||
      offset + 2 > bytes.length
    )
      return false;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (
        size < 8 ||
        !bytes.readUInt16BE(offset + 3) ||
        !bytes.readUInt16BE(offset + 5)
      )
        return false;
      frame = true;
    }
    if (marker === 218) {
      if (
        !frame ||
        size < 6 ||
        !bytes[offset + 2] ||
        size !== 6 + 2 * bytes[offset + 2]
      )
        return false;
      scan = true;
      entropy = true;
    }
    offset += size;
  }
  return false;
}
function validWebpBitstream(kind: string, data: Buffer): boolean {
  if (kind === 'VP8 ')
    return (
      data.length >= 10 &&
      data.subarray(3, 6).equals(Buffer.from([157, 1, 42])) &&
      !!(data.readUInt16LE(6) & 16383) &&
      !!(data.readUInt16LE(8) & 16383)
    );
  return (
    kind === 'VP8L' && data.length >= 5 && data[0] === 47 && !(data[4] & 224)
  );
}
// ANMF contains a frame header followed by padded chunks with a required VP8/VP8L bitstream.
// https://developers.google.com/speed/webp/docs/riff_container#animation
function completeWebpFrame(data: Buffer): boolean {
  let offset = 16;
  let image = false;
  while (offset + 8 <= data.length) {
    const kind = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > data.length || (size % 2 && data[end] !== 0)) return false;
    if (kind === 'ANMF' || kind === 'ANIM' || kind === 'VP8X') return false;
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (image || !validWebpBitstream(kind, data.subarray(offset + 8, end)))
        return false;
      image = true;
    }
    offset = paddedEnd;
  }
  return image && offset === data.length;
}
function completeWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length)
    return false;
  let offset = 12;
  let image = false;
  let extended = false;
  let animated = false;
  let animationHeader = false;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length || (size % 2 && bytes[end - 1] !== 0)) return false;
    if (kind === 'VP8X') {
      if (size !== 10 || offset !== 12) return false;
      extended = true;
      animated = !!(bytes[offset + 8] & 2);
    }
    if (kind === 'ANIM') {
      if (!animated || animationHeader || image || size !== 6) return false;
      animationHeader = true;
    }
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (
        animated ||
        image ||
        !validWebpBitstream(kind, bytes.subarray(offset + 8, offset + 8 + size))
      )
        return false;
      image = true;
    }
    if (kind === 'ANMF') {
      if (
        !extended ||
        !animationHeader ||
        !completeWebpFrame(bytes.subarray(offset + 8, offset + 8 + size))
      )
        return false;
      image = true;
    }
    offset = end;
  }
  return image && offset === bytes.length;
}
export function completeRaster(bytes: Buffer, format: string): boolean {
  if (format === 'png') return completePng(bytes);
  if (format === 'jpg') return completeJpeg(bytes);
  if (format === 'webp') return completeWebp(bytes);
  return false;
}
