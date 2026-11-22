// Empaqueta el cliente en un solo archivo sin dependencias, para que un agente
// lo pueda bajar con curl o correr con npx sin instalar nada más.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here("src/cli.ts")],
  outfile: here("dist/agentroom.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  // Sin minificar: quien lo baje puede leer el código completo antes de correrlo.
  minify: false,
  logLevel: "warning",
});
