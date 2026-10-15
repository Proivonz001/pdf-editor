// The brand mark: a page with a folded corner and a line under a yellow highlighter (the same
// drawing as public/icons/icon.svg, without its tile). Decorative; colours from tokens.css.
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      class="logo"
      width={Math.round(size * 0.81)}
      height={size}
      viewBox="212 132 600 744"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke-width="40" stroke-linejoin="round">
        <path class="logo-paper" d="M308 172H604L772 340V796A56 56 0 0 1 716 852H308A56 56 0 0 1 252 796V228A56 56 0 0 1 308 172Z" />
        <path class="logo-fold" d="M604 172V340H772Z" />
      </g>
      <rect class="logo-bar" x="304" y="488" width="416" height="104" rx="14" />
      <g stroke-width="36" stroke-linecap="round">
        <path class="logo-rule" d="M336 420H600" />
        <path class="logo-ink" d="M336 540H688" />
        <path class="logo-rule" d="M336 660H640" />
      </g>
    </svg>
  );
}
