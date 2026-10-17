// Licor, cigarrillos y vapeadores: se venden si los piden, nunca aparecen ni se sugieren solos.
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
const { buscar, paraAcompanar, pedidoGenerico } = await import("../lib/tienda.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const nombres = (q) => buscar(q).map((p) => p.nombre);
const hayLicor = (l) => l.some((n) => /cerveza|aguardiente|ron |whisky|vodka|cigarr|vuse|vape|encendedor|four loko|smirnoff/i.test(n));
ok("'cerveza' sí trae cervezas: " + nombres("cerveza").slice(0, 3).join(", "), hayLicor(nombres("cerveza")));
ok("'poker' trae Poker", nombres("poker").some((n) => /poker/i.test(n)));
ok("'una media de lucky' trae cajetilla Lucky", nombres("una media de lucky").some((n) => /lucky/i.test(n) && /cajetilla/i.test(n)));
ok("'aguardiente' trae aguardiente", nombres("aguardiente").some((n) => /aguardiente/i.test(n)));
ok("'encendedor' trae encendedor", nombres("encendedor").some((n) => /encendedor/i.test(n)));
for (const q of ["lata", "algo frio", "bebida", "gaseosa lata", "330", "manzana", "uva", "sandia", "botella", "media libra tomate", "jugo de mango", "papas", "six pack gaseosa"]) ok(`'${q}' sin licor ni cigarrillos (${nombres(q).slice(0, 3).join(", ")})`, !hayLicor(nombres(q)));
ok("cigarrillos ya no sugieren encendedor", paraAcompanar([{ sku: "x", name: "Cigarrillo Lucky Cajetilla X 10" }]) === null);
ok("'algo de beber' pregunta por gaseosa, jugo o agua", JSON.stringify(pedidoGenerico("algo de beber")?.tipos) === JSON.stringify(["Gaseosa", "Jugo", "Agua"]));
const acomp = paraAcompanar([{ sku: "x", name: "Papas Margarita Natural" }]);
ok("papas sugieren algo de tomar sin cerveza: " + (acomp?.productos || []).map((p) => p.nombre).join(", "), acomp && !hayLicor(acomp.productos.map((p) => p.nombre)));
const acomp2 = paraAcompanar([{ sku: "y", name: "Gaseosa Coca Cola 1.5 Lt" }]);
ok("gaseosa sugiere algo de picar sin licor: " + (acomp2?.productos || []).map((p) => p.nombre).join(", "), !acomp2 || !hayLicor(acomp2.productos.map((p) => p.nombre)));
