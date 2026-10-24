/**
 * JSX typings for the @material/web custom elements used in this app.
 * React 19 handles custom-element props (properties vs attributes) and
 * on* event props at runtime; these declarations just teach TSX that
 * the tags exist. Props are intentionally permissive — the components
 * are configured through their documented attributes/properties.
 */
import type * as React from "react";

type MdElementProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement>,
  HTMLElement
> &
  Record<string, unknown> & { children?: React.ReactNode };

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "md-filled-button": MdElementProps;
      "md-filled-tonal-button": MdElementProps;
      "md-outlined-button": MdElementProps;
      "md-text-button": MdElementProps;
      "md-icon-button": MdElementProps;
      "md-slider": MdElementProps;
      "md-input-chip": MdElementProps;
      "md-circular-progress": MdElementProps;
    }
  }
}

export {};
