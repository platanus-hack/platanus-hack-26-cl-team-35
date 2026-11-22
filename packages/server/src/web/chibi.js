// Chibis KUBO pintados en canvas con trazos de pastel. Lo usan la vista del cuarto y la de los lentes.
// Solo piezas propias: cada rasgo se busca en un mapa y lo que no esté cae al valor por defecto.
// La textura sale de semillas fijas, así que no cambia entre renders.
const seed = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rng = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
// Paleta por cuarto: cielo de los retratos, muros, piso, alfombra y plantas.
const PALETTES = [
  { sky:["#f6c3a6", "#f7e2c6", "#8b9be0", "#9fd8d2", "#f2a99a"], wallL:"#8b9be0", wallR:"#7383cc", floor:["#f6c3a6", "#efb390"], rug:"#7fc9c4", leaf:"#6fae8c" },
  { sky:["#bfe3c8", "#f7e8c6", "#8fc7b8", "#f2c79a", "#e8a58f"], wallL:"#7fb59a", wallR:"#6a9f85", floor:["#ecd9ad", "#dfc796"], rug:"#e8907a", leaf:"#4f9a73" },
  { sky:["#3f4a8a", "#8b9be0", "#f2a99a", "#9fd8d2", "#2d3160"], wallL:"#4b56a0", wallR:"#3d4789", floor:["#e2b9a4", "#d4a892"], rug:"#f0bf6a", leaf:"#7fc9a4" },
  { sky:["#d9c4ee", "#f7e2c6", "#b59bd8", "#f6c3a6", "#9fd8d2"], wallL:"#b59bd8", wallR:"#9f84c6", floor:["#f7e2c6", "#efd3b0"], rug:"#e8907a", leaf:"#7fb08a" },
  { sky:["#9fd8d2", "#f7e2c6", "#7fc9c4", "#f2a99a", "#8b9be0"], wallL:"#7fc9c4", wallR:"#68b3ae", floor:["#f7e2c6", "#f0d0a8"], rug:"#f2a99a", leaf:"#5f9e86" },
];
const INK = "#2d3160";
const HAIR = { black:"#2e2b3f", brown:"#7a4b33", blonde:"#efc777", red:"#c4563c", pink:"#f39aae", blue:"#6f8fe0", green:"#5fae8f", purple:"#9c7ad6", white:"#efe6dc" };
const CLOTH = ["#7b5cff", "#8eb8ff", "#bfa7ff", "#b7f3d9", "#ffb4a3"];
const O = (x, y, r) => "M" + (x - r) + " " + y + "a" + r + " " + r + " 0 1 0 " + 2 * r + " 0a" + r + " " + r + " 0 1 0 " + -2 * r + " 0";
// KUBO: piezas sacadas de la hoja de personaje. Cada pieza: [path SVG, color, modo].
// Color "c" = color del agente, "hair" = color del pelo. Modo f = relleno al pastel, d = relleno liso, s = línea.
const KUBO_LEGS = [["M20 59 H30 V70 Q30 73 27 73 H23 Q20 73 20 70 Z M34 59 H44 V70 Q44 73 41 73 H37 Q34 73 34 70 Z", "#8E78C1", "f"], ["M20 68 H30 V71 Q30 74 27 74 H23 Q20 74 20 71 Z M34 68 H44 V71 Q44 74 41 74 H37 Q34 74 34 71 Z", "#9B85CB", "f"]];
const KUBO_HANDS = [["M12 51 L19 55 L16 60 Q15 62 12 61 L8 59 Q6 57 8 55 Z M52 51 L45 55 L48 60 Q49 62 52 61 L56 59 Q58 57 56 55 Z", "#FFF6EA", "f"]];
const KUBO_HEAD = [["M22 5 H42 Q54 5 55 17 L56 28 Q57 42 44 43 H20 Q7 42 8 28 L9 17 Q10 5 22 5 Z", "#AAA4DD", "f"], ["M23 12 H41 Q48 12 49 20 L50 27 Q51 36 42 38 H22 Q13 36 14 27 L15 20 Q16 12 23 12 Z", "#FFF6EA", "f"], ["M22 30 A3.5 1.7 0 1 0 22 33.4 A3.5 1.7 0 1 0 22 30 Z M42 30 A3.5 1.7 0 1 0 42 33.4 A3.5 1.7 0 1 0 42 30 Z", "#FFB4A3", "d"], ["M28 1 H36 Q40 1 40 5 V10 Q40 14 36 14 H28 Q24 14 24 10 V5 Q24 1 28 1 Z", "hair", "f"]];
const OUTFIT = {
  hoodie: [["M22 43 Q26 41 32 42 Q38 41 42 43 L53 53 L47 58 L43 54 L44 62 Q44 65 40 65 H24 Q20 65 20 62 L21 54 L17 58 L11 53 Z", "c", "f"], ["M23 43 Q27 42 32 43 Q37 42 41 43 Q38 48 32 48 Q26 48 23 43 Z", "#8E78C1", "f"], ["M28 47 V53 M36 47 V53", "#62517F", "s"], ["M27 56 H37 L40 62 H24 Z", "#B5A5D9", "f"], ["M13 52 L18 56 M51 52 L46 56", "#62517F", "s"]],
  suit: [["M22 43 H42 L53 53 L47 58 L43 54 L44 62 Q44 65 40 65 H24 Q20 65 20 62 L21 54 L17 58 L11 53 Z", "c", "f"], ["M25 43 H39 L32 57 Z", "#FFF6EA", "f"], ["M32 45 L34 47 L33 49 L34 53 L32 57 L30 53 L31 49 L30 47 Z", "#D97C79", "d"], ["M25 43 L22 49 L26 50 L25 52 L32 58 L29 51 Z M39 43 L42 49 L38 50 L39 52 L32 58 L35 51 Z", "#8179B3", "f"], ["M32 58 V64 M13 52 L18 56 M51 52 L46 56", "#4D466F", "s"], ["M34 59 A1 1 0 1 0 34 61 A1 1 0 1 0 34 59 Z", "#F2CD87", "d"]],
  tshirt: [["M23 43 H41 L52 52 L47 56 L43 53 L44 62 Q44 65 39 65 H25 Q20 65 20 62 L21 53 L17 56 L12 52 Z", "c", "f"], ["M26 43 H38 Q36 46 32 46 Q28 46 26 43 Z", "#FFF6EA", "f"], ["M32 48 L27.5 50.5 L32 53 L36.5 50.5 Z M27.5 53 L23 55.5 L27.5 58 L32 55.5 Z M36.5 53 L32 55.5 L36.5 58 L41 55.5 Z", "#FFF6EA", "d"], ["M27.5 50.5 L32 53 V58 L27.5 55.5 Z M23 55.5 L27.5 58 V63 L23 60.5 Z M32 55.5 L36.5 58 V63 L32 60.5 Z", "#9A8BCB", "d"], ["M32 53 L36.5 50.5 V55.5 L32 58 Z M27.5 58 L32 55.5 V60.5 L27.5 63 Z M36.5 58 L41 55.5 V60.5 L36.5 63 Z", "#CDB9E5", "d"]],
  dress: [["M23 43 H41 L51 52 L47 56 L42 51 L40 55 Q43 62 49 66 Q32 70 15 66 Q21 62 24 55 L22 51 L17 56 L13 52 Z", "c", "f"], ["M26 43 H38 Q36 46 32 46 Q28 46 26 43 Z", "#FFF6EA", "f"]],
  lab: [["M24 43 H40 L52 53 L47 58 L43 54 L45 65 Q40 67 34 65 H30 Q24 67 19 65 L21 54 L17 58 L12 53 Z", "#FFF6EA", "f"], ["M27 43 H37 L35 63 H29 Z", "c", "f"], ["M29 43 H35 L32 50 Z", "#B7F3D9", "f"], ["M26 43 L23 48 L26 49 L24 52 L29 58 M38 43 L41 48 L38 49 L40 52 L35 58 M38 56 H42", "#80759B", "s"], ["M35.5 59 A0.8 0.8 0 1 0 35.5 60.6 A0.8 0.8 0 1 0 35.5 59 Z", "#80759B", "d"]],
};
const EYES = {
  dot: [["M23 21.5 A2.2 3.6 0 1 0 23 28.7 A2.2 3.6 0 1 0 23 21.5 Z M41 21.5 A2.2 3.6 0 1 0 41 28.7 A2.2 3.6 0 1 0 41 21.5 Z", "#22233F", "d"]],
  sparkle: [["M23 21 A2.8 3.9 0 1 0 23 28.8 A2.8 3.9 0 1 0 23 21 Z M41 21 A2.8 3.9 0 1 0 41 28.8 A2.8 3.9 0 1 0 41 21 Z", "#22233F", "d"], ["M23 21.8 L23.6 23.6 L25 24.3 L23.6 25 L23 26.8 L22.4 25 L21 24.3 L22.4 23.6 Z M41 21.8 L41.6 23.6 L43 24.3 L41.6 25 L41 26.8 L40.4 25 L39 24.3 L40.4 23.6 Z", "#FFFFFF", "d"]],
  sleepy: [["M19.5 25 Q23 29.5 26.5 25 M37.5 25 Q41 29.5 44.5 25", "#22233F", "s"]],
  wink: [["M23 21.5 A2.2 3.6 0 1 0 23 28.7 A2.2 3.6 0 1 0 23 21.5 Z", "#22233F", "d"], ["M37.5 26.5 Q41 22 44.5 26", "#22233F", "s"]],
  happy: [["M19.5 27 Q23 19.5 26.5 27 M37.5 27 Q41 19.5 44.5 27", "#22233F", "s"]],
};
const MOUTH = {
  happy: "M28.5 31.5 Q32 36 35.5 31.5",
  neutral: "M29.5 33 H34.5",
  focused: "M29.5 33.5 L34.5 32.5 M34.5 31.5 V33.5",
  excited: "M27.5 31.5 Q27.5 30 29 30 H35 Q36.5 30 36.5 31.5 Q36.5 36.5 32 36.5 Q27.5 36.5 27.5 31.5 Z",
  calm: "M29 32.5 Q32 35 35 32.5",
};
const ACC = {
  none: [],
  headphones: [["M6 24 V19 Q6 3 19 3 H45 Q58 3 58 19 V24 H54 V19 Q54 7 45 7 H19 Q10 7 10 19 V24 Z", "#B7F3D9", "f"], ["M7 20 H10 Q13 20 13 23 V31 Q13 34 10 34 H7 Q4 34 4 31 V23 Q4 20 7 20 Z M54 20 H57 Q60 20 60 23 V31 Q60 34 57 34 H54 Q51 34 51 31 V23 Q51 20 54 20 Z", "#9CDDC9", "f"], ["M55 32 Q55 37 45 37", "#527E78", "s"], ["M41.5 35 H45 Q47 35 47 37 Q47 39 45 39 H41.5 Q39.5 39 39.5 37 Q39.5 35 41.5 35 Z", "#B7F3D9", "f"]],
  glasses: [["M7.5 23 L15.5 24 M48.5 24 L56.5 23 M30.5 25 Q32 23 33.5 25 M23 17.5 A7.5 7.5 0 1 0 23 32.5 A7.5 7.5 0 1 0 23 17.5 Z M41 17.5 A7.5 7.5 0 1 0 41 32.5 A7.5 7.5 0 1 0 41 17.5 Z", "#65518C", "s"]],
  hat: [["M43 2 L55 5 Q56 5.5 55.5 7 L53.5 14 L40 11 L41.5 3 Q42 1.5 43 2 Z", "#7565A2", "f"], ["M40.5 9 L54.5 12 L53.5 15 L39.5 12 Z", "#B5A5D9", "f"], ["M37.5 11 Q38 10 40 10.5 L56.5 14 Q59 14.5 58 16.5 Q57.5 18 55 17.5 L39 14 Q36.5 13.5 37.5 11 Z", "#65548E", "f"]],
  bow: [["M45 8 L40 5 Q37 4 37 7 V11 Q37 14 40 13 L45 11 Z M47 8 L53 6 Q56 5 56 8 V12 Q56 15 53 14 L47 11 Z", "#AA8BD0", "f"], ["M45 7.5 H47 Q49 7.5 49 9.5 V11 Q49 13 47 13 H45 Q43 13 43 11 V9.5 Q43 7.5 45 7.5 Z", "#C5AAE2", "f"]],
  crown: [["M41 4 L46 7 L50 1 L53 7 L59 5 L56 14 Q55 16 53 15.5 L44 14 Q42 14 42 12 Z", "#F2CD87", "f"], ["M42 11.5 L56.8 13 L56 15 Q55 16 53 15.5 L44 14 Q42 14 42 12 Z", "#E9AF77", "f"]],
};
const PET = {
  none: [],
  axolotl: [["M75 61 Q66 62 64.5 67 Q65 69.5 69 69 Q75 68 78 63 Z", "#F3A58C", "f"], ["M72 52 Q66 50 65 46 Q65 44 67 45 L73 49 Z M72 56 Q66 55 64.5 52 Q64 50 66 50.5 L73 53 Z M73 59 Q68 59 65.5 57 Q64.5 55 67 55.5 L73 56 Z M83 49 L88 45 Q90 44 89.5 46 Q88 50 83 52 Z M83 53 L88 50.5 Q90 50 89.5 52 Q88 55 83 56 Z M83 56 L88 55.5 Q90 55 89.5 57 Q87 59 83 59 Z", "#F3A58C", "f"], ["M74 57 H81 Q84 57 84 62 L83 66 Q83 69 81 69 H79 V65 H76 V69 H73 Q71 69 72 66 L71 62 Q71 58 74 57 Z", "#FFB4A3", "f"], ["M73 47 Q77 45 82 47 Q87 48 87 53 Q87 59 82 60 H74 Q69 59 69 54 Q69 49 73 47 Z", "#FFB4A3", "f"], ["M74.3 52.6 A1 1.2 0 1 0 74.3 55 A1 1.2 0 1 0 74.3 52.6 Z M81.7 52.6 A1 1.2 0 1 0 81.7 55 A1 1.2 0 1 0 81.7 52.6 Z", "#22233F", "d"], ["M76.5 55.5 Q78 57.4 79.5 55.5", "#65517D", "s"]],
  cat: [["M84 60 Q89 60 88 54 Q87 52 89 52 Q90 52 90 55 Q90 63 84 64 Z", "#AAA4DD", "f"], ["M74 55 H83 Q87 55 87 60 V67 Q87 69 85 69 H82 V65 H77 V69 H74 Q72 69 72 67 V60 Q72 56 74 55 Z", "#AAA4DD", "f"], ["M67 48 L68 41 Q68.5 40 70 41 L74 45 H78 L82 41 Q83 40 84 42 L86 50 Q87 57 82 59 H72 Q66 58 66 53 Q66 50 67 48 Z", "#9690CD", "f"], ["M69 46 L69.5 43 L72.5 45.5 Z M80 45.5 L82.5 43 L83.5 47 Z", "#FFB4A3", "d"], ["M69.5 55 Q70 52 73 53 L76 54 L79 53 Q82 52 83 55 Q82 58.5 78 59 H74 Q70 58.5 69.5 55 Z", "#FFF6EA", "f"], ["M71.3 49.4 A1 1.3 0 1 0 71.3 52 A1 1.3 0 1 0 71.3 49.4 Z M80.7 49.4 A1 1.3 0 1 0 80.7 52 A1 1.3 0 1 0 80.7 49.4 Z M74.9 53.7 Q76 52.8 77.1 53.7 L76 55 Z", "#22233F", "d"], ["M73.5 55.5 Q75 57 76 55 Q77 57 78.5 55.5 M69.5 54 L65 53 M69.5 56 L64.5 57 M82.5 54 L87.5 53 M82.5 56 L88 57", "#65517D", "s"]],
  dog: [["M83 59 Q86 58 88 54 Q89 53 89.5 55 Q90 60 85 63 Z", "#BC8F72", "f"], ["M73 55 H82 Q87 55 87 60 V67 Q87 69 85 69 H82 V65 H77 V69 H74 Q72 69 72 67 V59 Q72 56 73 55 Z", "#D6A88D", "f"], ["M71 45 Q68 44 67 47 L64.5 53 Q64 56 67 56 Q70 56 72 52 Z M81 44 Q85 44 88 49 L89 53 Q89 56 86 56 Q83 56 81 52 Z", "#B38369", "f"], ["M72 44 Q76 42 81 44 Q85 47 85 52 Q85 58 80 59 H73 Q68 58 68 53 Q68 47 72 44 Z", "#D6A88D", "f"], ["M76 43 Q78 43 79 43.5 L78 52 Q83 52 83 55 Q82 59 77 59 Q71 59 71 55 Q71 52 74.5 52 Z", "#FFF6EA", "f"], ["M71.8 48.7 A1 1.4 0 1 0 71.8 51.5 A1 1.4 0 1 0 71.8 48.7 Z M81.2 48.7 A1 1.4 0 1 0 81.2 51.5 A1 1.4 0 1 0 81.2 48.7 Z M74.8 53 Q77 51.8 79.2 53 Q79 55 77 55 Q75 55 74.8 53 Z", "#22233F", "d"], ["M74.4 55.5 Q75.5 57.5 77 55 Q78.5 57.5 79.6 55.5", "#65517D", "s"]],
  shrimp: [["M82 62 Q79 63 76 65 Q74 66 75.5 67.5 L79.5 67 L77 69 Q77 70 79 70 Q83 69 85 66 Z", "#F3A58C", "f"], ["M72 48 Q74 44 81 46 Q89 48 89 56 Q89 63 84 66 L80 63 Q84 60 82 57 Q80 54 74 54 Z", "#F3A58C", "f"], ["M64.5 47 Q72 44 78 47 Q81 49 79 54 Q77 58 73 56 Q68 54 64.5 47 Z", "#FFB4A3", "f"], ["M79 47 Q80.5 50 79 54 M83.5 48 Q85 52 82 57 M87 52 Q87 56 83 60 M88 58 Q86 62 82.5 63.5", "#C27A72", "s"], ["M70 47 Q68 41 79 40 M72 47 Q71 43 82 43 M74 56 Q72 58 72 61 M77 56 Q75 59 75 62 M80 57 Q78 60 78 63", "#65517D", "s"], ["M73.5 48.5 A1.3 1.7 0 1 0 73.5 51.9 A1.3 1.7 0 1 0 73.5 48.5 Z", "#22233F", "d"]],
  bird: [["M74 64 V68 L71 69 M80 64 V68 L83 69", "#8D6B69", "s"], ["M70 51 Q69 46 74 44.5 L75 41 Q76 40 77 42.5 L80 41.5 Q81.5 42.5 80 45 Q84 47 84 52 L89 57 Q90 59 87 60 L84 59 Q83 66 77 66 Q68 66 67 59 Q66 54 70 51 Z", "#AAA4DD", "f"], ["M68.5 57 Q73 54 77 59 Q78.5 62 77 66 Q70 66 68.5 61 Z", "#F5CBAD", "f"], ["M78 53 Q83 52 84 56 Q85 60 81 61 Q77 61 77 57 Z", "#9790CB", "f"], ["M69.5 51.5 L64.5 54 Q65 55.5 69.5 56 Q71.5 54 69.5 51.5 Z", "#F2CD87", "f"], ["M73.5 48 A1.25 1.6 0 1 0 73.5 51.2 A1.25 1.6 0 1 0 73.5 48 Z", "#22233F", "d"]],
};
const pick = (map, v, fallback) => Object.prototype.hasOwnProperty.call(map, v) ? map[v] : map[fallback];
function tint(hex, k) {
  const n = parseInt(hex.slice(1), 16), t = k > 0 ? 255 : 40;
  const m = (c) => Math.round(c + (t - c) * Math.abs(k));
  return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((c) => m(c).toString(16).padStart(2, "0")).join("");
}
// Relleno de pastel: base suave y luego trazos cortos en diagonal con el color aclarado u oscurecido.
// `n` es la densidad por cada 64x64 unidades del recuadro.
function crayon(ctx, path, color, rnd, box, base = true, n = 260) {
  ctx.save(); ctx.clip(path);
  if (base) { ctx.globalAlpha = 0.9; ctx.fillStyle = color; ctx.fill(path); }
  ctx.lineCap = "round";
  const count = Math.round(n * box[2] * box[3] / 4096);
  for (let i = 0; i < count; i++) {
    const x = box[0] + rnd() * box[2], y = box[1] + rnd() * box[3], a = -0.85 + (rnd() - 0.5) * 0.5, l = 2 + rnd() * 4;
    ctx.globalAlpha = 0.35 + rnd() * 0.45;
    ctx.strokeStyle = tint(color, (rnd() - 0.45) * 0.7);
    ctx.lineWidth = 0.5 + rnd() * 0.9;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  ctx.restore();
}
function sketch(ctx, path, color, width, rnd, alpha = 0.8) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineCap = ctx.lineJoin = "round";
  for (let i = 0; i < 2; i++) {
    ctx.globalAlpha = i ? alpha * 0.45 : alpha; ctx.lineWidth = width * (i ? 0.7 : 1);
    ctx.setTransform(ctx.getTransform().translate((rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6));
    ctx.stroke(path);
  }
  ctx.restore();
}
function paintParts(ctx, parts, color, rnd, box, hair) {
  for (const [d, c, mode] of parts) {
    const p = new Path2D(d), col = c === "c" ? color : c === "hair" ? hair : c;
    if (mode === "s") { sketch(ctx, p, col, 1.5, rnd); continue; }
    if (mode === "d") { ctx.save(); ctx.globalAlpha = col === "#FFB4A3" ? 0.55 : 0.95; ctx.fillStyle = col; ctx.fill(p); ctx.restore(); continue; }
    crayon(ctx, p, col, rnd, box);
    sketch(ctx, p, INK, 0.9, rnd);
  }
}
/** Dibuja al agente en coordenadas de 90x64 (busto) o 90x76 (cuerpo entero, pies en y=74). */
function paintFigure(ctx, a, id, full) {
  a = a || {};
  const s = seed(id), rnd = rng(s);
  const color = /^#[0-9a-f]{6}$/i.test(a.palette || "") ? a.palette : CLOTH[s % CLOTH.length];
  const hair = pick(HAIR, a.hair, "purple");
  const box = [0, 0, 64, 76];
  if (full) paintParts(ctx, KUBO_LEGS, color, rnd, box, hair);
  paintParts(ctx, [...pick(OUTFIT, a.outfit, "hoodie"), ...KUBO_HANDS, ...KUBO_HEAD, ...pick(EYES, a.eyes, "dot"),
    [pick(MOUTH, a.mood, "happy"), INK, "s"], ...pick(ACC, a.accessory, "none")], color, rnd, box, hair);
  // La mascota va junto al pie; en el busto se sube para que quepa en el retrato.
  ctx.save(); ctx.translate(0, full ? 4 : -6);
  paintParts(ctx, pick(PET, a.pet, "none"), color, rnd, [64, 40, 26, 30], hair);
  ctx.restore();
}
