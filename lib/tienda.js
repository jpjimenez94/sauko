// Catálogo y pedido del lado del servidor, para los canales que no tienen página (WhatsApp).
import { CATALOGO, COSTO_DOMICILIO, DOMICILIO_GRATIS_DESDE } from "./comun.js";

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

export function totales(items) {
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const domicilio = subtotal === 0 || subtotal >= DOMICILIO_GRATIS_DESDE ? 0 : COSTO_DOMICILIO;
  return { subtotal, domicilio, total: subtotal + domicilio };
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
