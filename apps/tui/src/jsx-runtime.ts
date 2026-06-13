/**
 * JSX runtime shim for @opentui/solid.
 *
 * The @opentui/solid package only ships type declarations for jsx-runtime,
 * not the actual JS module. This shim re-exports from solid-js which
 * provides the standard JSX runtime functions that opentui's components
 * produce when transformed by babel-preset-solid.
 */
// solid-js/jsx-runtime exports: jsx, jsxs, Fragment
// solid-js also has jsxDEV for dev mode
import { Fragment, jsx, jsxs } from "solid-js/h/jsx-runtime";

// jsxDEV is used in development mode (NODE_ENV !== "production")
function jsxDEV(
  type: any,
  props: any,
  key?: string,
  _isStatic?: boolean,
  _source?: any,
  _self?: any,
) {
  if (key !== undefined) {
    return jsx(type, { ...props, key });
  }
  return jsx(type, props);
}

export { jsx, jsxs, jsxDEV, Fragment };
