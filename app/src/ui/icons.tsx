// Inline SVG icons (24×24 grid, 1.8 px strokes in currentColor). Decorative: the button that
// holds an icon carries the accessible name.
import type { ComponentChildren } from "preact";

function Svg({ children, size = 20 }: { children: ComponentChildren; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconOpen = () => (
  <Svg>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M12 11v5" />
    <path d="m9.5 13.5 2.5-2.5 2.5 2.5" />
  </Svg>
);

export const IconUndo = () => (
  <Svg>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const IconRedo = () => (
  <Svg>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
);

export const IconZoomOut = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.6-4.6" />
    <path d="M7.5 10.5h6" />
  </Svg>
);

export const IconZoomIn = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.6-4.6" />
    <path d="M7.5 10.5h6M10.5 7.5v6" />
  </Svg>
);

/** A small chevron: the "more download options" half of the split Download button. */
export const IconChevronDown = () => (
  <Svg size={16}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
);

/** A plain magnifier: the zoom row of the phone More sheet. */
export const IconZoom = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.6-4.6" />
  </Svg>
);

export const IconFitWidth = () => (
  <Svg>
    <path d="M3.5 5v14M20.5 5v14" />
    <path d="M7 12h10" />
    <path d="m9.5 9.5-2.5 2.5 2.5 2.5M14.5 9.5l2.5 2.5-2.5 2.5" />
  </Svg>
);

/** A "T" with a text cursor beside it. */
export const IconEditText = () => (
  <Svg>
    <path d="M3.5 7V5h11v2" />
    <path d="M9 5v14M6.5 19h5" />
    <path d="M18 8v12M16 8h4M16 20h4" />
  </Svg>
);

export const IconDownload = () => (
  <Svg>
    <path d="M12 4v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M5 20h14" />
  </Svg>
);

export const IconShare = () => (
  <Svg>
    <path d="M12 3.5v11" />
    <path d="m8 7.5 4-4 4 4" />
    <path d="M7 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1" />
  </Svg>
);

export const IconMore = () => (
  <Svg>
    <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconGlobe = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" />
  </Svg>
);

export const IconUpdate = () => (
  <Svg>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Svg>
);

export const IconClose = () => (
  <Svg>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const IconLock = () => (
  <Svg size={16}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Svg>
);


// Tools, panels, sheets and the home page

/** An arrow pointer: the "Browse" tool (scroll and zoom, nothing changes). */
export const IconPointer = () => (
  <Svg>
    <path d="M6 3.8 18.6 10.9l-5.7 1.6-2.8 5.7z" />
    <path d="m12.9 12.5 4.3 6.2" />
  </Svg>
);

/** Two stacked pages: the thumbnails. */
export const IconPages = () => (
  <Svg>
    <rect x="8.5" y="3.5" width="11" height="14" rx="1.6" />
    <path d="M5 7.5v11a2 2 0 0 0 2 2h8.5" />
  </Svg>
);

/** A window with a side column: the details panel. */
export const IconDetails = () => (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M14.5 4.5v15" />
    <path d="M16.9 8.5h1.4M16.9 11.5h1.4" />
  </Svg>
);

export const IconCheck = () => (
  <Svg>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

/** Back to the start (closes the document on phones). */
export const IconBack = () => (
  <Svg>
    <path d="M19.5 12h-15" />
    <path d="m10.5 6-6 6 6 6" />
  </Svg>
);

export const IconInfo = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <path d="M12 7.7v.1" />
  </Svg>
);

/** "Aa": fonts. */
export const IconFont = () => (
  <Svg>
    <path d="m3 18.5 5-13 5 13" />
    <path d="M4.9 13.7h6.2" />
    <circle cx="17.5" cy="15.5" r="3" />
    <path d="M20.5 12.5v6" />
  </Svg>
);

/** A laptop and a phone. */
export const IconDevices = () => (
  <Svg>
    <path d="M14.5 15H4.5a1.5 1.5 0 0 1-1.5-1.5V6.5A1.5 1.5 0 0 1 4.5 5h10A1.5 1.5 0 0 1 16 6.5V8" />
    <path d="M1.5 18.5h11" />
    <rect x="16.5" y="9" width="6" height="11.5" rx="1.5" />
    <path d="M19.5 17.8v.1" />
  </Svg>
);

/** A shield: the file stays on this device. */
export const IconShield = () => (
  <Svg>
    <path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

/** Angle brackets: source code. */
export const IconCode = () => (
  <Svg>
    <path d="m8.5 7-5 5 5 5" />
    <path d="m15.5 7 5 5-5 5" />
  </Svg>
);

export const IconMinus = () => (
  <Svg>
    <path d="M5.5 12h13" />
  </Svg>
);

export const IconPlus = () => (
  <Svg>
    <path d="M12 5.5v13M5.5 12h13" />
  </Svg>
);

// Images (edit mode)

/** A picture: a frame with a sun and hills. Replace the selected image. */
export const IconImage = () => (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="m4 17.5 4.5-4.5 3.5 3.5 2.5-2.5 5.5 5.5" />
  </Svg>
);

/** A square with an arrow turning clockwise over it: rotate 90° clockwise. */
export const IconRotate = () => (
  <Svg>
    <rect x="3.5" y="10.5" width="10" height="10" rx="1.6" />
    <path d="M8 6.5h5.5a5 5 0 0 1 5 5v2.5" />
    <path d="m16 11.5 2.5 2.5 2.5-2.5" />
  </Svg>
);

/** A bin: delete. */
export const IconTrash = () => (
  <Svg>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="m6.5 7 .9 11.6a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7" />
    <path d="M10 11v5.5M14 11v5.5" />
  </Svg>
);

/**
 * The four corners of a selection frame with a small cross inside: deselect the image (not the
 * check of the edit banner's Done, which leaves edit mode).
 */
export const IconDeselect = () => (
  <Svg>
    <path d="M4 8.5v-3A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3" />
    <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" />
  </Svg>
);

/** Four arrows from the centre: move (the grip of a selected image on touch screens). */
export const IconMove = () => (
  <Svg>
    <path d="M12 4v16M4 12h16" />
    <path d="m9.5 6.5 2.5-2.5 2.5 2.5M9.5 17.5l2.5 2.5 2.5-2.5M6.5 9.5 4 12l2.5 2.5M17.5 9.5 20 12l-2.5 2.5" />
  </Svg>
);

// Fill and sign (the tool, its sub-tools, the banner and the saved signatures)

/** A pen nib over a wavy line: the "Fill & sign" tool (rail and tab bar). */
export const IconSign = () => (
  <Svg>
    <path d="m15.5 4.5 4 4-7.5 7.5-5 1.2 1.2-5z" />
    <path d="m7.2 17 3.6-3.6" />
    <path d="M3.5 20.5c1.4-1.3 2.8-1.3 4.2 0s2.8 1.3 4.2 0 2.8-1.3 4.2 0" />
  </Svg>
);

/** A ticked box: the ✓ sub-tool (not the plain check of "Done"). */
export const IconTickBox = () => (
  <Svg>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="m8 12.5 2.8 2.8L16.5 9" />
  </Svg>
);

/** A crossed box: the ✗ sub-tool. */
export const IconCrossBox = () => (
  <Svg>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </Svg>
);

/** A calendar page: the date sub-tool. */
export const IconCalendar = () => (
  <Svg>
    <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    <path d="M8 14h.1M12 14h.1M16 14h.1M8 17.2h.1M12 17.2h.1" />
  </Svg>
);

/** A scribble on a signature line with its small cross: a signature (the Sign sub-tool, saved signatures). */
export const IconSignature = () => (
  <Svg>
    <path d="M3.5 19.5h17" />
    <path d="m4 13.5 2.5 2.5M6.5 13.5 4 16" />
    <path d="M9.5 16c.8-2.6 1.8-8.5 3.3-8.5 1.6 0-.9 7.5.6 7.5 1.1 0 1.7-3.2 2.9-3.2.9 0 .7 2.2 1.7 2.2.6 0 1.2-.6 1.6-1" />
  </Svg>
);

/** A page with a small scribble in its bottom corner: initials (the Initials sub-tool). */
export const IconInitials = () => (
  <Svg>
    <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
    <path d="M8 8h8M8 11h5" />
    <path d="M11.5 17c.6-1.6 1.2-3.6 2-3.6.9 0-.3 3.1.6 3.1.6 0 .9-1.2 1.6-1.2" />
  </Svg>
);

/** A crosshair: put the chosen thing in the middle of the visible page (keyboard path). */
export const IconTarget = () => (
  <Svg>
    <circle cx="12" cy="12" r="6.5" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    <path d="M12 12h.1" />
  </Svg>
);

/** A field with a text cursor and an arrow after it: go to the next empty form field. */
export const IconNextField = () => (
  <Svg>
    <rect x="3.5" y="7" width="10" height="10" rx="1.6" />
    <path d="M7.5 10v4" />
    <path d="M16.5 12h5" />
    <path d="m19 9.5 2.5 2.5-2.5 2.5" />
  </Svg>
);

// Fill and sign: the text writer (viewer)

/** A return arrow, down and back to the start: write the text and start a line below it. */
export const IconNewLine = () => (
  <Svg>
    <path d="M19 5v6.5a2.5 2.5 0 0 1-2.5 2.5H5.5" />
    <path d="m9 10.5-3.5 3.5L9 17.5" />
  </Svg>
);

// Installing the app (ui/InstallDialog.tsx and its entries). Our own drawings: the iPhone steps
// use IconShare above for the Share button, never Apple's symbols.

/** A phone with an arrow coming down into it: install the app (the entries and the toast). */
export const IconInstall = () => (
  <Svg>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.2" />
    <path d="M12 6.5v7.5" />
    <path d="m9 11 3 3 3-3" />
    <path d="M10.5 18.2h3" />
  </Svg>
);

/** A plus in a rounded square: "Add to Home Screen" in the iPhone steps. */
export const IconAddSquare = () => (
  <Svg>
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
);

/** Two overlapping sheets: copy (the app's link, for in-app browsers). */
export const IconCopy = () => (
  <Svg>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
);

// The page organizer (ui/organizer, viewer/Thumbnails.tsx). Duplicate uses IconCopy above, turning
// clockwise IconRotate, "From another PDF" IconOpen.

/** IconRotate mirrored: turn the pages 90° anticlockwise. */
export const IconRotateLeft = () => (
  <Svg>
    <rect x="10.5" y="10.5" width="10" height="10" rx="1.6" />
    <path d="M16 6.5h-5.5a5 5 0 0 0-5 5v2.5" />
    <path d="m8 11.5-2.5 2.5-2.5-2.5" />
  </Svg>
);

/** A page with an arrow leaving it at the top right: extract the pages into a new PDF. */
export const IconPageExtract = () => (
  <Svg>
    <path d="M12.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5" />
    <path d="m12 12 8-8" />
    <path d="M15 4h5v5" />
  </Svg>
);

/** Three lines beside an arrow up and down: move the pages to a position ("Move to…"). */
export const IconPageMove = () => (
  <Svg>
    <path d="M4 6.5h9M4 12h9M4 17.5h9" />
    <path d="M18 4.5v15" />
    <path d="m15.5 7 2.5-2.5L20.5 7M15.5 17l2.5 2.5 2.5-2.5" />
  </Svg>
);

/** A page with a folded corner and a plus: a blank page. */
export const IconPageBlank = () => (
  <Svg>
    <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
    <path d="M13.5 3.5V9H19" />
    <path d="M12 12.5v5M9.5 15h5" />
  </Svg>
);

/** A camera: pages from a photo or a scan. */
export const IconPageScan = () => (
  <Svg>
    <path d="M3.5 8.5a2 2 0 0 1 2-2h2.2l1.6-2.2h5.4l1.6 2.2h2.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);

// The scan flow (ui/scan): the camera is IconPageScan above, the gallery IconImage.

/** An arrow up: move a page up in the scan's tray. */
export const IconArrowUp = () => (
  <Svg>
    <path d="M12 19V5.5" />
    <path d="m6.5 11 5.5-5.5 5.5 5.5" />
  </Svg>
);

/** An arrow down: move a page down in the scan's tray. */
export const IconArrowDown = () => (
  <Svg>
    <path d="M12 5v13.5" />
    <path d="m6.5 13 5.5 5.5 5.5-5.5" />
  </Svg>
);

// -- r5: SearchUI

/** A magnifier over lines of text: Cerca (not the plain magnifier of the phone's Zoom row, IconZoom). */
export const IconSearch = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.6-4.6" />
    <path d="M7.8 9h5.4M7.8 12h3.4" />
  </Svg>
);

/** A chevron up: the previous search result. */
export const IconPreviousResult = () => (
  <Svg>
    <path d="m6 15 6-6 6 6" />
  </Svg>
);

/** A chevron down: the next search result. */
export const IconNextResult = () => (
  <Svg>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

/** Two sliders: the search options. */
export const IconSearchOptions = () => (
  <Svg>
    <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
    <circle cx="15" cy="8" r="2" />
    <circle cx="9" cy="16" r="2" />
  </Svg>
);

// Release 5: Modifica's Bianchetto and Oscura (ui/EditBar.tsx).

/** An eraser on a line: Bianchetto (white-out). */
export const IconWhiteout = () => (
  <Svg>
    <path d="M14.6 4.4a1.5 1.5 0 0 1 2.1 0l2.9 2.9a1.5 1.5 0 0 1 0 2.1L11 18H7.4l-3-3a1.5 1.5 0 0 1 0-2.1z" />
    <path d="m9.5 9.5 5 5" />
    <path d="M12 19.5h7.5" />
  </Svg>
);

/** Lines of text with a black bar over the middle one: Oscura (redact). */
export const IconRedact = () => (
  <Svg>
    <path d="M4 6h16M4 18h10" />
    <rect x="4" y="9.5" width="16" height="5" rx="1" fill="currentColor" />
  </Svg>
);
