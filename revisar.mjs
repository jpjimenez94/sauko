// Comprueba que el código de la página y del servidor no tenga errores de sintaxis.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const html = readFileSync("public/index.html", "utf8");
new Function("return (async () => {" + html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>")) + "})");
for (const carpeta of ["api", "lib"]) for (const f of readdirSync(carpeta)) execFileSync(process.execPath, ["--check", `${carpeta}/${f}`], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", "server.js"], { stdio: "inherit" });
console.log("Sin errores de sintaxis.");
