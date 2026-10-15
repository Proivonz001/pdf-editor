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

/** Large document illustration for the empty state. */
export const IconDocument = () => (
  <Svg size={56}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5" />
    <path d="M8.5 12.5h7M8.5 15.5h4.5" />
  </Svg>
);
