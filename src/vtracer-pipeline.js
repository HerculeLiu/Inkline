export function buildVTracerOptions(params) {
  return {
    preset: "poster",
    hierarchical: "cutout",
    mode: "spline",
    maxColors: Math.round(params.vtracerColors),
    filterSpeckle: Math.max(4, Math.round(params.minRegionArea)),
    simplify: 1.5,
    optimize: 1
  };
}

export function outlineVTracerSvg(svg, params) {
  const [red, green, blue] = params.outlineColor;
  const color = `rgb(${red} ${green} ${blue})`;
  const attributes = ` stroke="${color}" stroke-width="${params.outlineWidth}" stroke-linejoin="round" stroke-linecap="round"`;
  return svg.replace(/<path\b/g, `<path${attributes}`);
}

export function countSvgPaths(svg) {
  return (svg.match(/<path\b/g) || []).length;
}
