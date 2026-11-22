# Plantillas para generar chibis 2D

Dos prompts en cadena para cambiar el personaje que dibuja la vista del cuarto:

1. **Hoja de personaje**: un modelo de imagen dibuja todas las variantes por separado.
2. **Extracción**: un modelo de visión convierte la hoja en el JSON que consume `paintFigure` en `packages/server/src/web/chat.html`.

Se corre una vez por personaje. El JSON se revisa y se pega en las tablas `KUBO_LEGS`, `KUBO_HANDS`, `KUBO_HEAD`, `OUTFIT`, `EYES`, `MOUTH`, `ACC` y `PET`. Nada de esto corre al crear un cuarto.

Las variantes tienen que coincidir con `AVATAR` en `packages/protocol/src/index.ts`. Si se agrega una variante ahí, se agrega aquí también (`chibi-prompts.test.ts` lo revisa).

## Variables

El personaje base es KUVO. Si el modelo de imagen acepta referencia, adjuntar también la hoja de KUVO junto al prompt.

| Variable | Ejemplo (KUVO) |
|---|---|
| `{{CHARACTER}}` | `KUVO, a friendly AI teammate built from soft floating blocks` |
| `{{BODY}}` | `a wide rounded cream face block (about 45% of height) with small black eyes, tiny mouth and pink blush; one flat rounded block floating just above the head as "hair"; lavender side blocks like ears; small rounded block body; arms, hands and feet are separate soft blocks floating close to the body, with small gaps, no visible joints` |
| `{{STYLE}}` | `oil pastel with short diagonal hatching strokes (lower-left to upper-right, about 45°), visible paper grain, slightly wobbly hand-drawn navy outline (#2D3160)` |
| `{{PALETTE}}` | `deep violet #6B46E0, violet #9B7BEA, lavender #D8CCF6, cream #FBF1E6, mint #A9E8D6, pale periwinkle #D9E0F8, blush pink #F4B6C8` |

Usar solo colores claros salvo el violeta profundo en piezas chicas: la vista también se pensó para pantallas aditivas, donde lo oscuro se vuelve transparente.

En la referencia los roles se distinguen por un objeto: capa con estrella (strategist), lentes y libro (analyst), headset (coordinator), bolso (executor). Hoy `AVATAR` solo tiene headphones y glasses de esos; capa, libro y bolso necesitan agregarse a `accessory` en protocol antes de pedirlos en la hoja.

## 1. Hoja de personaje (modelo de imagen)

```
Character design sheet of {{CHARACTER}}, drawn in {{STYLE}}. Flat cream paper background (#FBF6EE), no shadows on the background, no text except small labels.

Chibi proportions, front 3/4 view, standing: {{BODY}}.
Palette only: {{PALETTE}}, navy outline #2D3160.

Layout, evenly spaced on a grid, each item isolated with empty space around it, all drawn at the same scale and the same pose:
Row 1: the default full-body character, large.
Row 2 (bodies, same head): hoodie, suit with white shirt and small red tie, tshirt, flared dress, white lab coat with colored collar.
Row 3 (eyes, face close-ups): dot, sparkle with white highlight, sleepy flat lines, wink, happy arcs.
Row 4 (mouths): happy smile, neutral line, focused small line, excited open mouth, calm soft smile.
Row 5 (accessories on the head): headphones, round glasses, hat, bow, crown.
Row 6 (small pets in the same style): axolotl, cat, dog, shrimp, bird.
Label each item with its name in small text underneath.
```

## 2. Extracción (modelo de visión)

Se adjunta la hoja del paso 1.

```
You are extracting a vector spec from a character design sheet so a Canvas renderer can redraw it procedurally. The renderer fills shapes with its own pastel hatching, so you only describe geometry and flat colors, never texture.

Coordinate system: one figure lives in a box 64 wide x 76 tall, origin top-left, y grows down. The head is centered at x=32 and ends around y=43. Feet rest on y=74. Pets live in a separate area x 64..90, y 40..70, next to the figure.

For every item on the sheet, return parts as [path, color, mode]:
- path: SVG path data (M, L, H, V, Q, A, Z only) in that coordinate system. Prefer few points; rounded blocks as rounded rectangles.
- color: hex from the sheet palette, "c" for the part that takes the agent's own color (main outfit color), or "hair" for the part that takes the hair color.
- mode: "f" filled shape, "d" small solid detail without texture (eyes, blush, highlights), "s" a line (mouth, glasses frame, cords).
Order parts back to front.

Return only JSON, with exactly these keys and item names:
{
  "base": [...],  // legs first (2 parts), then hands (1 part), then head, face plate, blush, hair (4 parts)
  "outfit": { "hoodie": [...], "suit": [...], "tshirt": [...], "dress": [...], "lab": [...] },
  "eyes": { "dot": [...], "sparkle": [...], "sleepy": [...], "wink": [...], "happy": [...] },
  "mouth": { "happy": "...", "neutral": "...", "focused": "...", "excited": "...", "calm": "..." },  // one path each
  "accessory": { "headphones": [...], "glasses": [...], "hat": [...], "bow": [...], "crown": [...] },
  "pet": { "axolotl": [...], "cat": [...], "dog": [...], "shrimp": [...], "bird": [...] }
}
Every item must be present. Do not invent items. If something is unclear, approximate it with simple rounded shapes rather than skipping it.
```

## Revisión antes de pegar

- Todas las claves presentes, sin sobrantes.
- Ningún número fuera de 0..76 (figura) o 0..90 (mascotas).
- Colores en hex, `"c"` o `"hair"`; modos `f`, `d` o `s`.
- `base` en el orden del prompt: el renderer toma piernas, manos y cabeza por posición.
- Abrir `npm run demo` y comparar contra la hoja. Ojos, boca y mascotas son lo que más suele corregirse a mano.
