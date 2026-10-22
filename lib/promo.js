// Promoción de la línea del asistente (WhatsApp): un descuento a los primeros pedidos de cada día y un
// descuento sorpresa al azar con tope diario. Lo decide el sistema al cerrar el pedido, nunca el
// asistente: así el total que cobra el domiciliario, la devuelta, el QR y la caja cuadran. Solo sobre
// los productos (no el domicilio ni la bolsa) y uno solo por cliente, en su primer pedido con
// descuento: quien ya tuvo el suyo (del día o sorpresa) no vuelve a tener. La tienda la prende y la ajusta
// en el panel.
import { leerAjustes, leerPromoDia, tomarClientePromo, soltarClientePromo, sumarPromoDia } from "./store.js";

export const PROMO_INICIAL = { activa: false, pct: 10, cupo: 10, sorpresaPct: 20, sorpresaTope: 1, sorpresaCada: 8 };

const entero = (v, min, max, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Lo que manda el panel, con límites sanos; lo que no venga conserva el valor vigente. */
export function promoLimpia(p = {}, actual = PROMO_INICIAL) {
  return {
    activa: typeof p.activa === "boolean" ? p.activa : Boolean(actual.activa),
    pct: entero(p.pct ?? actual.pct, 1, 50, PROMO_INICIAL.pct),
    cupo: entero(p.cupo ?? actual.cupo, 0, 500, PROMO_INICIAL.cupo),
    sorpresaPct: entero(p.sorpresaPct ?? actual.sorpresaPct, 0, 70, PROMO_INICIAL.sorpresaPct),
    sorpresaTope: entero(p.sorpresaTope ?? actual.sorpresaTope, 0, 50, PROMO_INICIAL.sorpresaTope),
    sorpresaCada: entero(p.sorpresaCada ?? actual.sorpresaCada, 1, 100, PROMO_INICIAL.sorpresaCada),
  };
}

export const leerPromo = async () => promoLimpia((await leerAjustes()).promo ?? {}, PROMO_INICIAL);

/** El día de la promoción es el de Cali (UTC-5, sin horario de verano). */
export const diaDeCali = (ms = Date.now()) => new Date(ms - 5 * 3600_000).toISOString().slice(0, 10);

/** Descuento en pesos sobre los productos, redondeado a $50 (la moneda más pequeña). */
export const valorDescuento = (subtotal, pct) => Math.round((subtotal * pct) / 100 / 50) * 50;

/** Lo que el asistente puede contarle al cliente mientras arma el pedido (no aparta nada). */
export async function promoParaCliente(cliente) {
  const promo = await leerPromo();
  if (!promo.activa) return null;
  const hoy = await leerPromoDia(diaDeCali(), cliente);
  if (hoy.usoCliente) return { aplica: false, motivo: "Este cliente ya tuvo su descuento antes: es uno solo por cliente." };
  const quedan = Math.max(0, promo.cupo - hoy.dia);
  if (!quedan) return { aplica: false, motivo: `Ya se dieron los ${promo.cupo} descuentos de hoy; mañana hay de nuevo.` };
  return { aplica: true, porcentaje: promo.pct, cupos_que_quedan_hoy: quedan };
}

/**
 * Al cerrar: decide y aparta el descuento, y lo deja en el pedido. Primero se sortea el sorpresa (no
 * gasta un cupo de los primeros del día); si no sale, se toma un cupo del día si queda.
 */
export async function apartarPromo(pedido, azar = Math.random) {
  if (pedido.descuento) return pedido.descuento;
  const promo = await leerPromo();
  if (!promo.activa || !pedido.cliente) return null;
  const dia = diaDeCali();
  if (!(await tomarClientePromo(pedido.cliente))) return null;
  let descuento = null;
  if (promo.sorpresaTope > 0 && promo.sorpresaPct > 0 && azar() < 1 / promo.sorpresaCada) {
    if ((await sumarPromoDia(dia, "sorpresa", 1)) <= promo.sorpresaTope) descuento = { tipo: "sorpresa", pct: promo.sorpresaPct, dia };
    else await sumarPromoDia(dia, "sorpresa", -1);
  }
  if (!descuento && promo.cupo > 0) {
    const numero = await sumarPromoDia(dia, "dia", 1);
    if (numero <= promo.cupo) descuento = { tipo: "dia", pct: promo.pct, dia, numero };
    else await sumarPromoDia(dia, "dia", -1);
  }
  if (!descuento) {
    await soltarClientePromo(pedido.cliente);
    return null;
  }
  pedido.descuento = descuento;
  return descuento;
}

/** Si el cierre falla o la tienda cancela el pedido, el cliente lo recupera y el cupo del día vuelve. */
export async function soltarPromo(pedido) {
  const d = pedido.descuento;
  if (!d) return;
  delete pedido.descuento;
  await soltarClientePromo(pedido.cliente);
  if (d.dia === diaDeCali()) await sumarPromoDia(d.dia, d.tipo, -1);
}

/** Para el panel: la configuración y cuántos descuentos van hoy. */
export async function promoDeHoy() {
  const promo = await leerPromo();
  const hoy = await leerPromoDia(diaDeCali());
  return { ...promo, hoy: { dia: Math.min(hoy.dia, promo.cupo), sorpresa: Math.min(hoy.sorpresa, promo.sorpresaTope) } };
}
