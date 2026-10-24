/**
 * Material Web (@material/web) registration.
 *
 * Side-effect imports define the custom elements. We intentionally use
 * Google's own controls for buttons and chips — their state,
 * ripple, focus and a11y behaviour replaces our hand-rolled button
 * animations wholesale. Bespoke widgets without an MWC equivalent
 * (drag-select, donut, customer morph rows) stay custom. Sliders are
 * also bespoke: Material Web has no M3 Expressive slider, so Kontur's
 * ExpressiveSlider implements the expressive sizes, wavy active track
 * and morphing handle on top of a native range input.
 *
 * Icons: md-icon would need the Material Symbols webfont, which our
 * strict CSP (font-src 'self') forbids loading from Google. The
 * components accept inline <svg> in their icon slots, so we keep
 * slotting our own local SVG icon set.
 *
 * Theming: --md-sys-color-* tokens are aliased to the project palette
 * in styles/tokens.css, so both themes carry over automatically.
 */
import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/chips/input-chip.js";
import "@material/web/progress/circular-progress.js";
