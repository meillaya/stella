import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
})

export const IconStar = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M12 3.6l2.35 6.05L20.4 12l-6.05 2.35L12 20.4l-2.35-6.05L3.6 12l6.05-2.35z" />
  </svg>
)

export const IconChat = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M20 15a3 3 0 0 1-3 3H9l-4 3v-6.2A6.8 6.8 0 0 1 4 10.5C4 6.9 7 4 10.8 4h2.4C17 4 20 6.9 20 10.5z" />
    <path d="M8.5 11h7M8.5 14h4.5" />
  </svg>
)

export const IconQuality = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M3.5 15.5h3l2.2-6 3.3 9 2.6-6h5.9" />
    <path d="M3.5 20h17" opacity=".35" />
  </svg>
)

export const IconTraces = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M4 6h10M4 12h16M4 18h7" />
    <circle cx="18" cy="6" r="1.6" />
    <circle cx="14" cy="18" r="1.6" />
  </svg>
)

export const IconDatasets = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
    <path d="M5 5.5v6c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6" />
    <path d="M5 11.5v6c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6" />
  </svg>
)

export const IconRuns = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M10 8.8l5 3.2-5 3.2z" />
  </svg>
)

export const IconImprove = ({ size = 20, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M4 20l4.5-4.5M6.5 6.5l11 11M13 4l1.1 2.9L17 8l-2.9 1.1L13 12l-1.1-2.9L9 8l2.9-1.1z" />
    <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
)

export const IconSearch = ({ size = 16, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="M15.5 15.5L20 20" />
  </svg>
)

export const IconPlus = ({ size = 16, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconThumbUp = ({ size = 15, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M7 21V9.8L11 3c1.2 0 2 .9 2 2.1V9h4.6a2 2 0 0 1 2 2.4l-1.2 6.4A3 3 0 0 1 15.5 21z" />
    <path d="M3.5 21h3.5V9.8H3.5z" />
  </svg>
)

export const IconThumbDown = ({ size = 15, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M17 3v11.2L13 21c-1.2 0-2-.9-2-2.1V15H6.4a2 2 0 0 1-2-2.4l1.2-6.4A3 3 0 0 1 8.5 3z" />
    <path d="M20.5 3H17v11.2h3.5z" />
  </svg>
)

export const IconExternal = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
)

export const IconChevronLeft = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
)

export const IconChevronRight = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </svg>
)

export const IconDownload = ({ size = 15, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M12 4v10M8 10.5l4 4 4-4" />
    <path d="M5 19.5h14" />
  </svg>
)

export const IconUpload = ({ size = 15, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M12 15V5M8 8.5l4-4 4 4" />
    <path d="M5 19.5h14" />
  </svg>
)

export const IconClock = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.8V12l3 1.8" />
  </svg>
)

export const IconCoin = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M14.4 9.2c-.5-.6-1.3-1-2.3-1-1.5 0-2.6.8-2.6 2s1 1.8 2.6 1.8 2.6.6 2.6 1.8-1.1 2-2.6 2c-1 0-1.9-.4-2.4-1" />
    <path d="M12 6.6v10.8" opacity=".45" />
  </svg>
)

export const IconRefresh = ({ size = 15, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M20 4.5V9h-4.5" />
  </svg>
)

export const IconCheck = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
)

export const IconX = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const IconFilter = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
)

export const IconShield = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M12 3.5l7 2.7v5.4c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6.2z" />
    <path d="M9 12l2.1 2.1L15.5 9.5" />
  </svg>
)

export const IconAlert = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M12 4.5L21 20H3z" />
    <path d="M12 9.5v4.5M12 17.2v.2" />
  </svg>
)

export const IconInfo = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 11v5M12 7.8v.2" />
  </svg>
)

export const IconArrowUpRight = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <path d="M7 17L17 7M9 7h8v8" />
  </svg>
)

export const IconCopy = ({ size = 14, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </svg>
)

export const IconMore = ({ size = 16, ...props }: IconProps) => (
  <svg {...base(size)} {...props}>
    <circle cx="5.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
)
