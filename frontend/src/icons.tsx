import type { SVGProps } from "react";

/** Aéza icon language: solid filled glyphs with rounded corners on a 20px
 * grid. Self-hosted inline SVG only — no icon font/CDN, strict-CSP safe.
 * Dark cut-outs read `--icon-cutout` from CSS (set by keycap tiles). */
type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps): IconProps {
  return {
    viewBox: "0 0 20 20",
    fill: "currentColor",
    stroke: "none",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export const IconGrid = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.6" y="2.6" width="6.2" height="6.2" rx="2" />
    <rect x="11.2" y="2.6" width="6.2" height="6.2" rx="2" />
    <rect x="2.6" y="11.2" width="6.2" height="6.2" rx="2" />
    <rect x="11.2" y="11.2" width="6.2" height="6.2" rx="3.1" />
  </svg>
);

export const IconUsers = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="7.4" cy="6.5" r="3.2" />
    <path d="M1.7 17.4c.5-3.6 2.7-5.5 5.7-5.5 3 0 5.2 1.9 5.7 5.5H1.7Z" />
    <circle cx="14.3" cy="7.5" r="2.5" />
    <path d="M13.6 11.7c2.2.3 4.1 2 4.7 5.7h-3.2c-.3-2.2-1-4-2.3-5.2.3-.2.5-.3.8-.5Z" />
  </svg>
);

export const IconSliders = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4" width="15" height="2" rx="1" />
    <rect x="2.5" y="9" width="15" height="2" rx="1" />
    <rect x="2.5" y="14" width="15" height="2" rx="1" />
    <circle className="icon-knob" cx="7" cy="5" r="2.15" />
    <circle className="icon-knob" cx="13" cy="10" r="2.15" />
    <circle className="icon-knob" cx="9" cy="15" r="2.15" />
  </svg>
);

export const IconShield = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10 1.9 15.9 4v5.1c0 4.1-2.5 7-5.9 8.9C6.6 16.1 4.1 13.2 4.1 9.1V4L10 1.9Z" />
    <rect className="icon-cutout" x="9.15" y="5.8" width="1.7" height="5" rx=".85" />
    <circle className="icon-cutout" cx="10" cy="13.4" r="1" />
  </svg>
);

export const IconWallet = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4" width="15" height="12.4" rx="3" />
    <rect className="icon-cutout" x="2.5" y="7.1" width="15" height="1.8" />
    <circle className="icon-cutout" cx="14.2" cy="12" r="1.25" />
  </svg>
);

export const IconCalendar = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="6" y="2.4" width="2" height="3.4" rx="1" />
    <rect x="12" y="2.4" width="2" height="3.4" rx="1" />
    <rect x="2.7" y="4.4" width="14.6" height="13" rx="3" />
    <rect className="icon-cutout" x="2.7" y="7.8" width="14.6" height="1.7" />
    <circle className="icon-cutout" cx="6.8" cy="12.3" r="1.15" />
    <circle className="icon-cutout" cx="10" cy="12.3" r="1.15" />
    <circle className="icon-cutout" cx="13.2" cy="12.3" r="1.15" />
  </svg>
);

export const IconUpload = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10 1.8 5.4 6.4h3v6.1h3.2V6.4h3L10 1.8Z" />
    <path d="M3 12.4h3v3h8v-3h3v3.3c0 1-.8 1.8-1.8 1.8H4.8C3.8 17.5 3 16.7 3 15.7v-3.3Z" />
  </svg>
);

export const IconLogout = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4.2 2.6h5v2.3H5.4v10.2h3.8v2.3h-5c-1.1 0-2-.9-2-2V4.6c0-1.1.9-2 2-2Z" />
    <path d="M11.2 5.9 15.4 10l-4.2 4.1v-2.7H7.1V8.6h4.1V5.9Z" />
  </svg>
);

export const IconSun = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10" cy="10" r="3.4" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
      <rect
        key={deg}
        x="9.1"
        y="1.3"
        width="1.8"
        height="3.1"
        rx=".9"
        transform={`rotate(${deg} 10 10)`}
      />
    ))}
  </svg>
);

export const IconMoon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M16.9 12.1A7.2 7.2 0 0 1 7.9 3.1a.7.7 0 0 0-.9-.9 8.4 8.4 0 1 0 10.8 10.8.7.7 0 0 0-.9-.9Z" />
  </svg>
);

export const IconChevron = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4.7 6.8 10 12l5.3-5.2 1.8 1.9L10 15.8 2.9 8.7l1.8-1.9Z" />
  </svg>
);

export const IconArrowUpRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.9 14.1 12.6 5.4l2 2-8.7 8.7-2-2Z" />
    <path d="M8.4 3.8h7.8v7.8h-2.8V6.6H8.4V3.8Z" />
  </svg>
);

export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="8" y="3" width="9.2" height="11" rx="2.4" opacity=".45" />
    <path
      fillRule="evenodd"
      d="M5.2 6h9a2.4 2.4 0 0 1 2.4 2.4v7a2.4 2.4 0 0 1-2.4 2.4h-9a2.4 2.4 0 0 1-2.4-2.4v-7A2.4 2.4 0 0 1 5.2 6Zm.1 2.4v7h8.8v-7H5.3Z"
    />
  </svg>
);

export const IconMail = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.4" y="4.2" width="15.2" height="11.6" rx="3" />
    <path className="icon-cutout" d="M3.4 5.7 10 10.4l6.6-4.7 1 1.5-7.6 5.4-7.6-5.4 1-1.5Z" />
  </svg>
);

export const IconCheck = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7.9 14.9 3.4 10.4l1.9-1.9 2.6 2.6 7-7.2 2 1.9-9 9.1Z" />
  </svg>
);

export const IconLock = (p: IconProps) => (
  <svg {...base(p)}>
    <path
      fillRule="evenodd"
      d="M6.2 8.5V6.1a3.8 3.8 0 1 1 7.6 0v2.4h-2.3V6.1a1.5 1.5 0 1 0-3 0v2.4H6.2Z"
    />
    <rect x="3.4" y="8.3" width="13.2" height="9.3" rx="2.6" />
    <circle className="icon-cutout" cx="10" cy="12.2" r="1.25" />
    <rect className="icon-cutout" x="9.35" y="12.7" width="1.3" height="2.2" rx=".65" />
  </svg>
);

export const IconClose = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="8.9" y="3" width="2.2" height="14" rx="1.1" transform="rotate(45 10 10)" />
    <rect x="8.9" y="3" width="2.2" height="14" rx="1.1" transform="rotate(-45 10 10)" />
  </svg>
);

export const IconBell = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10 1.8a6 6 0 0 1 6 6v3.2l1.5 2.8a1 1 0 0 1-.9 1.5H3.4a1 1 0 0 1-.9-1.5L4 11V7.8a6 6 0 0 1 6-6Z" />
    <path d="M7.9 17a2.15 2.15 0 0 0 4.2 0H7.9Z" />
  </svg>
);

export const IconBolt = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M11.4 1.7 4.3 11h4.1l-1 7.3L14.7 9h-4.2l.9-7.3Z" />
  </svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8.7 3.9 3.4 10l5.3 6.1 1.8-1.6-3.2-3.4h9.9V8.9H7.3l3.2-3.4-1.8-1.6Z" />
  </svg>
);

export const IconArrowRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M11.3 3.9 16.6 10l-5.3 6.1-1.8-1.6 3.2-3.4H2.8V8.9h9.9L9.5 5.5l1.8-1.6Z" />
  </svg>
);
