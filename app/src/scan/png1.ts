// A 1-bit grey PNG writer for "Bianco e nero" pages. A canvas can only write 8-bit RGBA PNGs
// (125 KB for an A4 page at 200 dpi, against 47 KB at 1 bit), and the engine's picture path
// (images.checkPicture → newcontent.addImage) embeds a 1-bit grey PNG as a 1-bit DeviceGray
// image, which snapshots and downloads store as CCITT G4 (verified in the research probes, and
// rendering back pixel-identical). The PNG is IHDR (bit depth 1, colour type 0), pHYs (the
// page's resolution), one IDAT and IEND; rows use filter 0 (none), which suits 1-bit pictures.
// zlib comes from CompressionStream("deflate") (Chrome 80, Firefox 113, Safari 16.4, Node 18);
// where it is missing the data is stored in uncompressed deflate blocks: a valid PNG about as
// large as the bits themselves (1.1 MB for A4 at 300 dpi), which the engine compresses anyway.

let crcTable: Uint32Array | null = null;

/** CRC-32 (ISO 3309, as PNG uses it) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32 of `bytes` (the zlib checksum). */
export function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  // 5552 bytes is the most that can be summed before the sums must be reduced (zlib's NMAX).
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** `data` as a zlib stream of stored (uncompressed) deflate blocks. */
export function zlibStored(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78; // deflate, 32 KB window
  out[1] = 0x01; // no preset dictionary, fastest; (0x78 × 256 + 0x01) is a multiple of 31
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535, len = Math.min(65535, data.length - start);
    out[o] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE 00 (stored)
    out[o + 1] = len & 0xff;
    out[o + 2] = len >>> 8;
    out[o + 3] = ~len & 0xff;
    out[o + 4] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o + 5);
    o += 5 + len;
  }
  const sum = adler32(data);
  out[o] = sum >>> 24;
  out[o + 1] = (sum >>> 16) & 0xff;
  out[o + 2] = (sum >>> 8) & 0xff;
  out[o + 3] = sum & 0xff;
  return out;
}

/** `data` as a zlib stream: compressed where CompressionStream exists, stored blocks otherwise. */
export async function zlib(data: Uint8Array<ArrayBuffer>, { compress = true } = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (compress && typeof CompressionStream === "function") {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Fall through to stored blocks.
    }
  }
  return zlibStored(data);
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A 1-bit grey PNG of `width` × `height` pixels from rows of bits (each row padded to whole
 * bytes, bit 1 = white, as enhance.threshold writes them), with `dpi` in its pHYs chunk.
 * `compress: false` writes stored blocks (what happens where CompressionStream is missing).
 */
export async function png1(bits: Uint8Array, width: number, height: number, dpi: number, { compress = true } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const rowBytes = (width + 7) >> 3;
  if (!(width > 0 && height > 0) || bits.length < rowBytes * height) throw new Error("The bits do not fill the picture");
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) raw.set(bits.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 1; // bit depth
  header[9] = 0; // colour type: grey; compression, filter method and interlace stay 0
  const phys = new Uint8Array(9);
  const pv = new DataView(phys.buffer);
  const perMetre = Math.round(dpi / 0.0254);
  pv.setUint32(0, perMetre);
  pv.setUint32(4, perMetre);
  phys[8] = 1; // unit: metre
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("pHYs", phys),
    chunk("IDAT", await zlib(raw, { compress })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
