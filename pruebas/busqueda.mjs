// Búsqueda del asistente con casos reales que fallaron: el empaque no cuenta ("un paquete de tostados"),
// lo que la nota de voz oye mal ("Sonti" → Suntea, "stropajo" → esponja) y lo fresco por libra va primero
// ("plátano maduro"), salvo que pida mecato ("papas para picar").
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const { buscar } = await import(pathToFileURL(process.cwd() + "/").href + "lib/tienda.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const primero = (q) => buscar(q)[0]?.nombre ?? "";

ok("'un paquete de tostados' trae los Tostados", /^Tostados/.test(primero("un paquete de tostados")));
ok("'sobrecito de Sonti' (nota de voz) trae Suntea", /^Suntea/.test(primero("sobrecito de sonti")));
ok("'stropajo' trae esponjas", /^Esponj/.test(primero("stropajo")));
ok("'plátano maduro' trae el Plátano (libra) primero", primero("plátano maduro") === "Plátano (libra)");
ok("'plátano maduro para freír' también", primero("plátano maduro para freir") === "Plátano (libra)");
ok("'papas para picar' sigue trayendo papas de paquete", /^Papa Primavera/.test(primero("papas para picar")));
ok("'natuchips plátano maduro' trae los Natuchips", /^Natuchips/.test(primero("natuchips platano maduro")));
ok("'sobre de manila' no pierde el sobre", /^Sobre De Manila/.test(primero("sobre de manila")));
