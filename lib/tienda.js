// Catálogo y pedido del lado del servidor, para los canales que no tienen página (WhatsApp).
import { CATALOGO, datosTransferencia, totales, horario, momentoDe, revisarProgramado } from "./comun.js";

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9.]+/g, " ").trim();
const LISTA = [...CATALOGO].map(([sku, p]) => ({ sku, nombre: p.nombre, precio: p.precio, n: norm(p.nombre), tok: norm(p.nombre).split(" ") }));

// Pedidos genéricos: palabras que no nombran un producto sino una familia. Buscarlas tal cual trae
// cosas sin relación ("dulce" → maíz dulce), así que se le devuelven al asistente los tipos por los que
// debe preguntar. Cada tipo es una palabra que sí funciona en la búsqueda.
const GENERICOS = [
  [["dulce", "golosina", "antojo", "confite"], ["Chocolatina", "Gomas", "Galletas"]],
  [["mecato", "pasaboca", "snack", "picar", "paquete"], ["Papas", "Maní", "Doritos"]],
  [["bebida", "tomar", "refresco", "liquido", "sed"], ["Gaseosa", "Jugo", "Agua"]],
  [["trago", "licor", "alcohol", "beber"], ["Cerveza", "Aguardiente", "Ron"]],
  [["aseo", "limpieza", "limpiar"], ["Jabón", "Detergente", "Papel higiénico"]],
  [["desayuno", "desayunar"], ["Pan", "Huevos", "Leche"]],
];
const RELLENO = new Set(["un", "una", "unos", "unas", "algo", "alguna", "algun", "de", "del", "para", "el", "la", "los", "las", "que", "quiero", "necesito", "tienes", "tienen", "hay", "me", "das", "dame", "venden", "por", "favor", "porfa", "y", "o", "a", "con", "cosa", "cosas", "rico", "rica", "bueno"]);

/** Si lo pedido es una familia y no un producto, los tipos por los que hay que preguntar; si no, null. */
export function pedidoGenerico(consulta) {
  const palabras = norm(consulta).split(" ").filter((t) => t && !RELLENO.has(t)).map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
  if (!palabras.length) return null;
  const familia = GENERICOS.find(([claves]) => palabras.every((t) => claves.includes(t)));
  return familia
    ? { pedido_generico: true, tipos: familia[1], instruccion: "El cliente no dijo qué producto quiere. No ofrezcas productos todavía: pregúntale qué tipo busca y ofrécele estos tipos con ofrecer_botones. Cuando elija uno, búscalo con esa palabra." }
    : null;
}

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
    // El nombre empieza por el tipo de producto: si coincide con lo pedido, es justo eso y no un sabor o un acompañante.
    if (palabras.length === 1 && palabras.includes(p.tok[0].length > 4 && p.tok[0].endsWith("s") ? p.tok[0].slice(0, -1) : p.tok[0])) puntos += 1;
    if (aciertos >= minimo) hallados.push([puntos, p]);
  }
  // A igual coincidencia gana el más vendido: el catálogo viene ordenado por ventas y el orden se conserva.
  hallados.sort((a, b) => b[0] - a[0]);
  return hallados.slice(0, cuantos).map(([, p]) => ({ sku: p.sku, nombre: p.nombre, precio: p.precio, disponible: !agotados[p.sku], tiene_foto: Boolean(CATALOGO.get(p.sku)?.foto) }));
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
    ...totales(pedido.items, momentoDe(pedido)),
    entrega_programada: pedido.programado?.texto ?? null,
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
  let entrega = ahora.encargo ? `Es un encargo: ${ahora.encargo.replace("Encargo: ", "")}. No prometas entrega antes.` : "Llega en máximo 10 minutos.";
  let encargo = ahora.encargo;
  // Entrega programada: se vuelve a revisar al cerrar, por si la hora ya pasó mientras armaban el pedido.
  if (pedido.programado) {
    const revisado = revisarProgramado(pedido.programado.ts);
    if (revisado.error) throw new Error(`${revisado.error} Pídele otra hora al cliente o deja el pedido para entrega inmediata.`);
    pedido.programado = revisado;
    entrega = `La entrega quedó programada para ${revisado.texto}. No prometas entrega antes de esa hora.`;
    encargo = `Programado: ${revisado.fijo}`;
  }
  const { total } = totales(pedido.items, momentoDe(pedido));
  Object.assign(pedido, { total, encargo });

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
