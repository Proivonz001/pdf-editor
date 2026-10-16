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
