// Nav and status icons.
//
// ChartRoom draws these from lucide-react at a fixed stroke weight per context
// (2 for nav, 2.2 for stat chips). Arcadia's surfaces are server-rendered with
// no client bundle, so the same geometry is inlined as Preact components —
// same icon set, same weights, no runtime.
//
// Geometry from lucide (ISC), 24×24 viewBox.

import type { JSX } from "preact";

interface IconProps {
  size?: number;
  strokeWidth?: number;
}

function Icon(props: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  const { size = 18, strokeWidth = 2, children } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export type IconComponent = (props: IconProps) => JSX.Element;

/** Directory. */
export const Users: IconComponent = (p) => (
  <Icon {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

/** Schedule. */
export const CalendarClock: IconComponent = (p) => (
  <Icon {...p}>
    <path d="M16 14v2.2l1.6 1" />
    <path d="M16 2v3" />
    <path d="M21 7.338V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2.338" />
    <path d="M3 9h5.859" />
    <path d="M8 2v3" />
    <circle cx="16" cy="16" r="6" />
  </Icon>
);

/** Continuing Education. */
export const GraduationCap: IconComponent = (p) => (
  <Icon {...p}>
    <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
    <path d="M22 10v6" />
    <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
  </Icon>
);

/** Admin. */
export const ShieldCheck: IconComponent = (p) => (
  <Icon {...p}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const LogOut: IconComponent = (p) => (
  <Icon {...p}>
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  </Icon>
);

export const ChevronUp: IconComponent = (p) => (
  <Icon {...p}>
    <path d="m18 15-6-6-6 6" />
  </Icon>
);

/** Arcadia's own mark: the radar sweep — she watches, she does not decide. */
export const ArcadiaMark = (props: { size?: number }): JSX.Element => {
  const size = props.size ?? 26;
  return (
    <svg
      class="mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" />
      <path d="M4 6h.01" />
      <path d="M2.29 9.62A10 10 0 1 0 21.31 8.35" />
      <path d="M16.24 7.76A6 6 0 1 0 8.23 16.67" />
      <path d="M12 18h.01" />
      <path d="M17.99 11.66A6 6 0 0 1 15.77 16.67" />
      <circle cx="12" cy="12" r="2" />
      <path d="m13.41 10.59 5.66-5.66" />
    </svg>
  );
};
