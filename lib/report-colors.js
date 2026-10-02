/* The billing groups' colours — ONE definition for the screen and the .xlsx.
 *
 * public/style.css carries the same hex values as CSS tokens on :root
 * (--grp-<key>); test/billing-tab-section-colors.test.js fails if the two
 * drift apart. The screen uses the base colour for the heading text, the 4px
 * bar and the chip, over a ~9% tint of it on the dark surface. The workbook
 * derives three shades from the same base (xlsxShades): a dark fill for the
 * white section heading, a light tint for the column headers and a medium
 * tint for the totals.
 *
 * Pure: no I/O. */

const GROUP_COLORS = {
  due:        '#7aa2ff', // blue   — «לגבייה בתאריך הנבחר»
  open:       '#f5b041', // amber  — «יתרות פתוחות מתאריכים קודמים»
  credits:    '#3ddc84', // green  — «זיכויים ממתינים לתשלום» / הוחלט
  awaiting:   '#b892ff', // purple — «ממתין להחלטה — לא לתשלום»
  unresolved: '#a3acc2', // grey   — «לא ניתן לחשב» and the separate lists
  debt:       '#ff7a7a', // red    — «חובות פתוחים» / «חוב רשום»
  unrecorded: '#ff9f43', // orange — «מחזורים ללא רישום»
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) throw new Error('report-colors: bad hex ' + hex);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToArgb(rgb) {
  return 'FF' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/* `amount` of `hex` over `over` (both '#rrggbb'). */
function mix(hex, over, amount) {
  const a = hexToRgb(hex), b = hexToRgb(over);
  return a.map((v, i) => v * amount + b[i] * (1 - amount));
}

/* WCAG relative luminance and contrast ratio. */
function luminance(rgb) {
  const c = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(rgbA, rgbB) {
  const [x, y] = [luminance(rgbA), luminance(rgbB)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* The three workbook shades of one group colour, as exceljs ARGB strings. */
function xlsxShades(key) {
  const hex = GROUP_COLORS[key];
  if (!hex) throw new Error('report-colors: unknown colour ' + key);
  return {
    heading: rgbToArgb(mix(hex, '#000000', 0.5)),   // white bold text on it (AA)
    header:  rgbToArgb(mix(hex, '#ffffff', 0.18)),  // light tint
    total:   rgbToArgb(mix(hex, '#ffffff', 0.4)),   // medium tint
  };
}

module.exports = { GROUP_COLORS, xlsxShades, hexToRgb, mix, contrast, luminance };
