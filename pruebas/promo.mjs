// Promoción de la línea del asistente: cupos del día, sorpresa con tope, uno solo por cliente, solo sobre
// los productos, y el cupo vuelve si el cierre falla o se cancela. Sin bases ni servicios reales.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
const store = await import(raiz + "lib/store.js");
const promo = await import(raiz + "lib/promo.js");
const { totalesDe } = await import(raiz + "lib/tienda.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const pedido = (cliente) => ({ cliente, items: [{ sku: "x", name: "Arroz", price: 16000, qty: 2 }], status: "armando", domicilioFijo: 2000, bolsaFija: 200, total: 0 });
const sale = () => 0, noSale = () => 0.99;

ok("apagada: no hay descuento", (await promo.apartarPromo(pedido("57300000001"), sale)) === null && (await promo.promoParaCliente("57300000001")) === null);

await store.guardarAjustes({ promo: { activa: true, pct: 10, cupo: 2, sorpresaPct: 20, sorpresaTope: 1, sorpresaCada: 8 } });
const p1 = pedido("57300000001");
const d1 = await promo.apartarPromo(p1, noSale);
ok("primer pedido del día: 10 % de bienvenida (#1)", d1?.tipo === "dia" && d1.pct === 10 && d1.numero === 1);
const t1 = totalesDe(p1);
ok("solo sobre los productos: $32.000 − $3.200 + domicilio + bolsa", t1.descuento === 3200 && t1.total === 32000 - 3200 + 2000 + 200);

const p2 = pedido("57300000002");
const d2 = await promo.apartarPromo(p2, sale);
ok("le sale la sorpresa: 20 % y no gasta cupo del día", d2?.tipo === "sorpresa" && d2.pct === 20 && totalesDe(p2).descuento === 6400);
const d3 = await promo.apartarPromo(pedido("57300000003"), sale);
ok("la sorpresa tiene tope de 1 al día: el siguiente recibe el de bienvenida (#2)", d3?.tipo === "dia" && d3.numero === 2);
ok("se acabaron los cupos: sin descuento", (await promo.apartarPromo(pedido("57300000004"), noSale)) === null);
const sinCupo = await promo.promoParaCliente("57300000005");
ok("y el asistente sabe por qué", sinCupo && sinCupo.aplica === false && /2 descuentos de hoy/.test(sinCupo.motivo));

ok("uno solo por cliente: el que ya tuvo el suyo no vuelve a tener", (await promo.apartarPromo(pedido("57300000001"), sale)) === null && (await promo.promoParaCliente("57300000001")).aplica === false);
ok("quien no consiguió cupo hoy no queda marcado", !(await store.leerPromoDia(promo.diaDeCali(), "57300000004")).usoCliente);

await promo.soltarPromo(p1);
ok("si se cancela: el cliente lo recupera y el cupo vuelve", !p1.descuento && (await promo.promoParaCliente("57300000001")).aplica === true && (await promo.promoDeHoy()).hoy.dia === 1);

const hoy = await promo.promoDeHoy();
ok("el panel ve la configuración y lo de hoy", hoy.activa && hoy.cupo === 2 && hoy.hoy.sorpresa === 1);
ok("lo que manda el panel se limita a valores sanos", JSON.stringify(promo.promoLimpia({ pct: 500, cupo: -3, sorpresaCada: 0 })) === JSON.stringify({ activa: false, pct: 50, cupo: 0, sorpresaPct: 20, sorpresaTope: 1, sorpresaCada: 1 }));
