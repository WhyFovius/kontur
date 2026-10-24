import type { SVGProps } from "react";

/** Stroke icon set drawn on a 20px grid (matches the legacy UI language,
 *  self-hosted: no icon font, no CDN — CSP friendly). */
type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps): IconProps {
  return {
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export const IconGrid = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="2.5" width="6" height="6" rx="1.8" />
    <rect x="11.5" y="2.5" width="6" height="6" rx="1.8" />
    <rect x="2.5" y="11.5" width="6" height="6" rx="1.8" />
    <rect x="11.5" y="11.5" width="6" height="6" rx="1.8" />
  </svg>
);

export const IconUsers = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="7" r="3.2" />
    <path d="M2.5 17c.4-3 2.3-4.6 5.5-4.6s5.1 1.6 5.5 4.6M14 5.2a2.9 2.9 0 0 1 0 5.5m1.1 1.9c1.5.7 2.3 2.1 2.4 4.4" />
  </svg>
);

export const IconSliders = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 5h14M3 10h14M3 15h14" />
    <circle cx="7" cy="5" r="2" />
    <circle cx="13" cy="10" r="2" />
    <circle cx="9" cy="15" r="2" />
  </svg>
);

export const IconShield = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10 2.2 16 4v5c0 4.2-2.6 7-6 8.8C6.6 16 4 13.2 4 9V4l6-1.8Z" />
    <path d="M10 6.2v4.2m0 2.4v.1" />
  </svg>
);

export const IconWallet = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 6.5h12.5A1.5 1.5 0 0 1 17 8v7.5H4.5A1.5 1.5 0 0 1 3 14V5a2 2 0 0 1 2-2h9" />
    <path d="M13 10.8h4" />
    <circle cx="13" cy="11" r=".7" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCalendar = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4.5" width="14" height="13" rx="2" />
    <path d="M6.5 2.5v4m7-4v4M3 8h14" />
  </svg>
);

export const IconUpload = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M3.5 12.5v3A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </svg>
);

export const IconLogout = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8m3-3 4-4-4-4m4 4H7" />
  </svg>
);

export const IconSun = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10" cy="10" r="3.5" />
    <path d="M10 1.8v2m0 12.4v2M1.8 10h2m12.4 0h2M4.2 4.2l1.4 1.4m8.8 8.8 1.4 1.4m0-11.6-1.4 1.4m-8.8 8.8-1.4 1.4" />
  </svg>
);

export const IconMoon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M16.8 12.3A7 7 0 0 1 7.7 3.2a7.2 7.2 0 1 0 9.1 9.1Z" />
  </svg>
);

export const IconChevron = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m6 8 4 4 4-4" />
  </svg>
);

export const IconArrowUpRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 14 14 6M8.5 6H14v5.5" />
  </svg>
);

export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    <path d="M13.5 6.5v-2A1.5 1.5 0 0 0 12 3H4A1.5 1.5 0 0 0 2.5 4.5v8A1.5 1.5 0 0 0 4 14h2.5" />
  </svg>
);

export const IconMail = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
    <path d="m3.5 6 6.5 4.5L16.5 6" />
  </svg>
);

export const IconCheck = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m3.5 10.5 4 4 9-9.5" />
  </svg>
);

export const IconLock = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="8.5" width="13" height="9" rx="2" />
    <path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5" />
  </svg>
);

export const IconClose = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m5 5 10 10M15 5 5 15" />
  </svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M17 10H3m0 0 4.5-4.5M3 10l4.5 4.5" />
  </svg>
);

export const IconArrowRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 10h14m0 0-4.5-4.5M17 10l-4.5 4.5" />
  </svg>
);
