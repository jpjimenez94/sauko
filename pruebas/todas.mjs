// Corre todas las pruebas, cada una en su propio proceso. Todo lo externo (WhatsApp, Meta, Claude, Groq,
// Redis, Postgres) va simulado: no gasta créditos ni toca datos reales.
// Uso: npm test        (la de carga tarda ~30 s; para saltarla: npm test -- --rapido)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const carpeta = dirname(fileURLToPath(import.meta.url));
const rapido = process.argv.includes("--rapido");
const archivos = readdirSync(carpeta).filter((f) => f.endsWith(".mjs") && f !== "todas.mjs" && !(rapido && f === "carga.mjs")).sort();
let malas = 0;
for (const archivo of archivos) {
  const inicio = Date.now();
  const r = spawnSync(process.execPath, [join(carpeta, archivo)], { cwd: join(carpeta, ".."), encoding: "utf8", timeout: 300000 });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fallas = salida.split("\n").filter((l) => l.startsWith("FALLA"));
  const bien = r.status === 0 && !fallas.length;
  if (!bien) malas++;
  console.log(`${bien ? "✔" : "✘"} ${archivo} (${((Date.now() - inicio) / 1000).toFixed(1)} s)`);
  if (!bien) console.log((fallas.length ? fallas.join("\n") : salida.split("\n").slice(-15).join("\n")).replace(/^/gm, "    "));
}
console.log(malas ? `\n${malas} de ${archivos.length} pruebas fallaron.` : `\nLas ${archivos.length} pruebas pasaron.`);
process.exit(malas ? 1 : 0);
