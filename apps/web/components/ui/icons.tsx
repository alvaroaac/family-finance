/**
 * Line-art SVG icon set — "Editorial acolhedor".
 *
 * Paths copied verbatim from docs/design/2026-07-02-claude-design-mockups/.
 * All icons: 24×24 viewBox, `stroke="currentColor"`, stroke-width 1.7,
 * round caps/joins, `fill="none"` — color comes from the parent's `color`.
 */
import type { ReactElement, ReactNode } from "react";

export type IconProps = { size?: number };

function Svg({ size = 18, children }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconHome(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M3 11.5 L12 4.5 L21 11.5" />
      <path d="M5.5 10 V19.5 H18.5 V10" />
    </Svg>
  );
}

export function IconGrid(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function IconTransfer(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 8h13" />
      <path d="M14 5l3 3-3 3" />
      <path d="M20 16H7" />
      <path d="M10 13l-3 3 3 3" />
    </Svg>
  );
}

export function IconUpload(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </Svg>
  );
}

export function IconTag(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 4h7l9 9-7 7-9-9z" />
      <circle cx="8" cy="8" r="1.3" />
    </Svg>
  );
}

export function IconBank(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 9.5 L12 4 L20 9.5" />
      <path d="M6 10v8" />
      <path d="M12 10v8" />
      <path d="M18 10v8" />
      <path d="M4 20h16" />
    </Svg>
  );
}

export function IconCard(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10.5h18" />
    </Svg>
  );
}

export function IconJar(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M7 8.5h10V19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" />
      <path d="M6 5.5h12" />
    </Svg>
  );
}

export function IconSliders(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <circle cx="9" cy="7" r="2" />
      <path d="M4 17h16" />
      <circle cx="15" cy="17" r="2" />
    </Svg>
  );
}

export function IconPencil(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </Svg>
  );
}

export function IconTrash(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
    </Svg>
  );
}

export function IconDoc(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
    </Svg>
  );
}

export function IconPlusCircle(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </Svg>
  );
}

export function IconDots(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </Svg>
  );
}
