// Our own sRGB ICC profile, built in code: the colour declaration (output intent) of every
// PDF/A file the app writes (src/engine/pdfa.ts).
//
// Why not ship a profile file: the widely copied ones (ICC's sRGB2014, the Ghostscript/Artifex
// profiles inside MuPDF) come with licence terms of their own or unclear ones, and a PDF/A file
// carries its profile to whoever receives it. This one is a plain description of the sRGB
// standard (IEC 61966-2-1), written here, so it can be embedded in anyone's files freely.
//
// What it is: an ICC version 2.1 display profile (class "mntr", colour space RGB, PCS XYZ), the
// classic "matrix/TRC" form that every colour engine understands. Version 2 rather than 4: PDF/A-1
// accepts only profiles below version 4 and PDF/A-2 below 5, so 2.1 is valid for both. The
// primaries are the sRGB ones adapted to the D50 profile connection space with the Bradford
// transform (the values every sRGB profile uses), and each channel's tone curve samples the sRGB
// transfer function at 1024 points (one curve shared by the three channels). The bytes are
// always the same: a fixed creation date, no random profile ID.

/** Name of the profile (its "desc" tag): shown by colour-aware programs. */
export const SRGB_PROFILE_NAME = "sRGB (PDF Editor)";

/** The ICC header's creation date. Fixed, so the profile's bytes never change. */
const CREATED = [2026, 10, 15, 0, 0, 0];

/** D50 in s15Fixed16, exactly as ICC.1 requires it in the header (X 0.9642, Y 1.0, Z 0.8249). */
const D50_FIXED = [0x0000f6d6, 0x00010000, 0x0000d32d];

/** sRGB primaries, Bradford-adapted to D50 (columns of the RGB to XYZ matrix). */
const RED_XYZ = [0.4360747, 0.2225045, 0.0139322];
const GREEN_XYZ = [0.3850649, 0.7168786, 0.0971045];
const BLUE_XYZ = [0.1430804, 0.0606169, 0.7141733];

/** Points of the tone curve: enough for 16-bit interpolation to stay within a fraction of a level. */
const CURVE_POINTS = 1024;

/** The sRGB electro-optical transfer function (IEC 61966-2-1): encoded value to linear light. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

let cached: Uint8Array | null = null;

/**
 * The profile's bytes (about 2.5 KB). A fresh copy each time: the caller may hand it to MuPDF,
 * which takes it over.
 */
export function srgbProfile(): Uint8Array {
  cached ??= buildProfile();
  return cached.slice();
}

/** One tag: its signature and its data (padded to 4 bytes when laid out). */
interface Tag {
  sig: string;
  data: Uint8Array;
}

function buildProfile(): Uint8Array {
  const curve = curveType();
  const tags: Tag[] = [
    { sig: "desc", data: textDescriptionType(SRGB_PROFILE_NAME) },
    { sig: "cprt", data: textType("No copyright, use freely") },
    { sig: "wtpt", data: xyzTypeFixed(D50_FIXED) },
    { sig: "rXYZ", data: xyzType(RED_XYZ) },
    { sig: "gXYZ", data: xyzType(GREEN_XYZ) },
    { sig: "bXYZ", data: xyzType(BLUE_XYZ) },
    // The same curve data for the three channels: ICC allows tags to share one data element.
    { sig: "rTRC", data: curve },
    { sig: "gTRC", data: curve },
    { sig: "bTRC", data: curve },
  ];

  // Lay out: 128-byte header, tag table (count + 12 bytes per tag), then each distinct data
  // element at a 4-byte-aligned offset.
  const tableSize = 4 + 12 * tags.length;
  const offsets = new Map<Uint8Array, number>();
  let size = 128 + tableSize;
  for (const tag of tags) {
    if (offsets.has(tag.data)) continue;
    offsets.set(tag.data, size);
    size += align4(tag.data.length);
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);

  // Header (ICC.1:2001-04, clause 6.1).
  view.setUint32(0, size); // profile size
  // 4: preferred CMM type, none (0)
  view.setUint32(8, 0x02100000); // version 2.1.0
  ascii(out, 12, "mntr"); // device class: display
  ascii(out, 16, "RGB "); // colour space of the data
  ascii(out, 20, "XYZ "); // profile connection space
  CREATED.forEach((v, i) => view.setUint16(24 + 2 * i, v)); // date and time, 6 x uint16
  ascii(out, 36, "acsp"); // profile file signature
  // 40: primary platform, none; 44: flags; 48: manufacturer; 52: model; 56: attributes (8 bytes)
  view.setUint32(64, 0); // rendering intent: perceptual
  D50_FIXED.forEach((v, i) => view.setInt32(68 + 4 * i, v)); // PCS illuminant
  // 80: creator, none; 84-127: reserved (zero in version 2)

  // Tag table.
  view.setUint32(128, tags.length);
  tags.forEach((tag, i) => {
    const at = 132 + 12 * i;
    ascii(out, at, tag.sig);
    view.setUint32(at + 4, offsets.get(tag.data)!);
    view.setUint32(at + 8, tag.data.length);
  });
  for (const [data, offset] of offsets) out.set(data, offset);
  return out;
}

const align4 = (n: number) => (n + 3) & ~3;

function ascii(out: Uint8Array, at: number, text: string) {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
}

/** s15Fixed16Number: signed, 16 fraction bits. */
const s15Fixed16 = (v: number) => Math.round(v * 65536);

/** XYZType (one XYZ number), from s15Fixed16 values already encoded. */
function xyzTypeFixed(fixed: number[]): Uint8Array {
  const data = new Uint8Array(20);
  const view = new DataView(data.buffer);
  ascii(data, 0, "XYZ ");
  fixed.forEach((v, i) => view.setInt32(8 + 4 * i, v));
  return data;
}

const xyzType = (xyz: number[]) => xyzTypeFixed(xyz.map(s15Fixed16));

/** curveType: CURVE_POINTS uint16 samples of the sRGB transfer function. */
function curveType(): Uint8Array {
  const data = new Uint8Array(12 + 2 * CURVE_POINTS);
  const view = new DataView(data.buffer);
  ascii(data, 0, "curv");
  view.setUint32(8, CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++)
    view.setUint16(12 + 2 * i, Math.round(srgbToLinear(i / (CURVE_POINTS - 1)) * 65535));
  return data;
}

/** textType (version 2 "cprt"): ASCII, NUL-terminated. */
function textType(text: string): Uint8Array {
  const data = new Uint8Array(8 + text.length + 1);
  ascii(data, 0, "text");
  ascii(data, 8, text);
  return data;
}

/**
 * textDescriptionType (version 2 "desc"): the ASCII description, then empty Unicode and
 * ScriptCode descriptions (their fixed-size fields are still required).
 */
function textDescriptionType(text: string): Uint8Array {
  const n = text.length + 1; // with the NUL
  const data = new Uint8Array(12 + n + 4 + 4 + 2 + 1 + 67);
  const view = new DataView(data.buffer);
  ascii(data, 0, "desc");
  view.setUint32(8, n);
  ascii(data, 12, text);
  // Unicode language code (4) and count (4) = 0; ScriptCode code (2) and count (1) = 0;
  // 67 bytes of ScriptCode description, zero.
  return data;
}
