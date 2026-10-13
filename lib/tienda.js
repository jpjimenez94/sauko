// Catálogo y pedido del lado del servidor, para los canales que no tienen página (WhatsApp).
import { CATALOGO, datosTransferencia, totales, horario } from "./comun.js";

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9.]+/g, " ").trim();
const LISTA = [...CATALOGO].map(([sku, p]) => ({ sku, nombre: p.nombre, precio: p.precio, n: norm(p.nombre), tok: norm(p.nombre).split(" ") }));

/** Misma búsqueda por palabras que usa la página. */
export function buscar(consulta, agotados = {}, cuantos = 8) {
  const palabras = norm(consulta).split(" ").filter(Boolean).map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
  if (!palabras.length) return [];
  const minimo = Math.ceil(palabras.length * 0.5);
  const hallados = [];
  for (const p of LISTA) {
    let puntos = 0;
    let aciertos = 0;
    for (const t of palabras) {
      if (p.tok.includes(t)) (puntos += 2), aciertos++;
      else if (p.tok.some((x) => x.startsWith(t))) (puntos += 1.5), aciertos++;
      else if (t.length > 2 && p.n.includes(t)) (puntos += 1), aciertos++;
    }
    if (aciertos >= minimo) hallados.push([puntos, p]);
  }
  hallados.sort((a, b) => b[0] - a[0] || a[1].nombre.length - b[1].nombre.length);
  return hallados.slice(0, cuantos).map(([, p]) => ({ sku: p.sku, nombre: p.nombre, precio: p.precio, disponible: !agotados[p.sku] }));
}

export function pedidoNuevo(canal, cliente) {
  const ahora = Date.now();
  return {
    id: "p" + ahora.toString(36) + Math.random().toString(36).slice(2, 10),
    no: 1000 + (Math.floor(ahora / 1000) % 9000),
    canal,
    cliente,
    direccion: "",
    pago: "",
    pagaCon: 0,
    status: "armando",
    items: [],
    total: 0,
    proof: "",
    proofMonto: 0,
    rechazo: 0,
    hora: ahora,
  };
}

/** Lo que el asistente necesita saber del pedido, sin la foto del comprobante. */
export function resumen(pedido) {
  return {
    estado: pedido.status,
    items: pedido.items.map((i) => ({ sku: i.sku, nombre: i.name, cantidad: i.qty })),
    ...totales(pedido.items),
    direccion: pedido.direccion || null,
    metodo_pago: pedido.pago || null,
  };
}

/**
 * Cierra el pedido según la forma de pago. Cambia el pedido y devuelve lo que el asistente debe decir.
 * Lanza un error con lo que falta, para que el asistente se lo pida al cliente.
 */
export function cerrar(pedido, pagaCon) {
  const falta = [];
  if (!pedido.items.length) falta.push("productos");
  if (!pedido.direccion) falta.push("dirección");
  if (!pedido.pago) falta.push("forma de pago (Transferencia o Contraentrega)");
  if (falta.length) throw new Error("Falta: " + falta.join(", "));
  // El total y si es encargo quedan fijos con la hora en que se cierra.
  const ahora = horario();
  const { total } = totales(pedido.items);
  const entrega = ahora.encargo ? `Es un encargo: ${ahora.encargo.replace("Encargo: ", "")}. No prometas entrega antes.` : "Llega en máximo 10 minutos.";
  Object.assign(pedido, { total, encargo: ahora.encargo });

  if (pedido.pago === "Contraentrega") {
    const billete = Math.floor(Number(pagaCon) || 0);
    if (billete < total) throw new Error(`Falta saber con cuánto paga el cliente; debe ser al menos ${total}. Pregúntale con qué billete paga.`);
    Object.assign(pedido, { pagaCon: billete, status: "alistando" });
    return {
      total,
      paga_con: billete,
      devuelta: billete - total,
      siguiente: `El pedido ya está en la tienda. Confírmale al cliente el total, que paga al recibir y cuánta devuelta le llevan. ${entrega}`,
    };
  }

  pedido.status = "esperando_pago";
  const datos = datosTransferencia();
  return {
    total,
    datos_para_transferir: datos || null,
    siguiente:
      (datos
        ? "Dale al cliente esos datos tal cual y pídele la foto del comprobante. El sistema le envía aparte el código QR de pago."
        : "Aún no tienes los datos de la cuenta: dile que la tienda se los comparte por este chat y pídele la foto del comprobante cuando pague. No inventes números de cuenta.") + ` ${entrega}`,
  };
}
