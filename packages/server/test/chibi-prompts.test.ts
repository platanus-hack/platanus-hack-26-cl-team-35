// Las plantillas de chibis piden exactamente las variantes que acepta el avatar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AVATAR } from "@agent-board/protocol";

test("docs/prompts/chibi-2d.md nombra cada variante de AVATAR", () => {
  const doc = readFileSync("docs/prompts/chibi-2d.md", "utf8");
  for (const key of ["eyes", "outfit", "accessory", "mood", "pet"] as const) {
    for (const v of AVATAR[key]) {
      if (v === "none") continue;
      assert.match(doc, new RegExp(`"${v}"`), `falta la variante ${key}.${v} en el JSON de extracción`);
    }
  }
});
