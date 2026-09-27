// Shoelace draws its built-in icons (the select's chevron, the option's check)
// from data: URLs it fetches, which this site's connect-src refuses. The same
// icons ship in its package, so they are loaded from this origin instead.
import { registerIconLibrary } from "/vendor/shoelace/utilities/icon-library.js";

const RENAMED = { caret: "caret-down-fill", indeterminate: "dash-lg", radio: "circle-fill" };

registerIconLibrary("system", {
  resolver: (name) => `/vendor/shoelace/assets/icons/${RENAMED[name] ?? name}.svg`,
  mutator: (svg) => svg.setAttribute("fill", "currentColor"),
});
