// 发色：只定一个底色，其余几档（耳后那层、外翻发尾的底面、高光、发丝线）都从它推出来，换色时整套跟着变。
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16); let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h * 360, s, l];
}
function hslToHex(h, s, l) {
  h /= 360; const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return "#" + [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
function hairPalette(base) {
  const [h, s, l] = hexToHsl(base);
  return { hair: base, hairBack: hslToHex(h - 2, s * 0.95, l - 0.07), hairShade: hslToHex(h - 4, s * 0.95, l - 0.13), hairLight: hslToHex(h + 2, s * 0.9, l + 0.12), hairLine: hslToHex(h - 6, s * 0.9, 0.26) };
}
module.exports = { hairPalette };
