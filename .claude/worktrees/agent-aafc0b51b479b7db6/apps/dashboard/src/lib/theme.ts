// Real per-tenant white-label theming: derives the small set of CSS custom
// properties the shell overrides (see styles.css's :root defaults) from a
// tenant's validated primary_color hex (packages/db/migrations/
// 210_add_branding_to_tenants.sql; apps/api/src/routes/tenants.ts validates
// it's a real 6-digit hex before it's ever stored). Never guesses a color —
// returns null when no valid primary_color is set, so Layout.tsx falls back
// to the default theme untouched.

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, n));
}

/** A ~12% darker shade of the same hue, for the hover state. */
function darken(rgb: { r: number; g: number; b: number }, amount = 0.12): string {
  const r = clamp(Math.round(rgb.r * (1 - amount)));
  const g = clamp(Math.round(rgb.g * (1 - amount)));
  const b = clamp(Math.round(rgb.b * (1 - amount)));
  return `rgb(${r}, ${g}, ${b})`;
}

export interface BrandCssVars {
  "--primary": string;
  "--primary-hover": string;
  "--primary-soft": string;
  "--sidebar-active-bg": string;
}

/** Returns inline-style CSS custom properties for a tenant's brand color, or null if unset/invalid. */
export function brandCssVars(primaryColor: string | null | undefined): BrandCssVars | null {
  if (!primaryColor) return null;
  const rgb = hexToRgb(primaryColor);
  if (!rgb) return null;
  const { r, g, b } = rgb;
  return {
    "--primary": primaryColor,
    "--primary-hover": darken(rgb),
    "--primary-soft": `rgba(${r}, ${g}, ${b}, 0.12)`,
    "--sidebar-active-bg": `rgba(${r}, ${g}, ${b}, 0.28)`,
  };
}
