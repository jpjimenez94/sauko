// Catálogo y pedido del lado del servidor, para los canales que no tienen página (WhatsApp).
import { CATALOGO, TIPOS, datosTransferencia, totales, horario, momentoDe, revisarProgramado } from "./comun.js";

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9.]+/g, " ").trim();
// Licor, cigarrillos y vapeadores: WhatsApp no deja promoverlos. El asistente los vende si el cliente los
// pide, pero no aparecen en búsquedas que no los nombran (así nunca los ofrece por su cuenta).
const ES_LICOR = /\b(cerveza|aguardiente|ron|whisky|vodka|tequila|vino|refajo|licor|brandy|ginebra|smirnoff|four loko|coctel|caneca|baileys|buchanans|ponche|michelada)\b/;
const restringido = (p, n) => TIPOS[p.tipo] === "Cigarrillos y accesorios" || (TIPOS[p.tipo] === "Bebidas" && ES_LICOR.test(n));
const LISTA = [...CATALOGO].map(([sku, p]) => ({ sku, nombre: p.nombre, precio: p.precio, n: norm(p.nombre), tok: norm(p.nombre).split(" "), restringido: restringido(p, norm(p.nombre)) }));
// Palabras con las que el cliente pide licor o cigarrillos: el tipo, la jerga o la marca.
const PIDE_RESTRINGIDO = new Set([
  "cerveza", "pola", "birra", "chela", "aguardiente", "guaro", "ron", "whisky", "whiskey", "vodka", "tequila", "vino", "refajo", "licor", "trago", "alcohol", "coctel", "caneca", "sixpack", "six",
  "cigarrillo", "cigarro", "cajetilla", "pucho", "tabaco", "vape", "vapeador", "vaper", "pod", "encendedor", "cuero", "filtro", "pipa", "grinder", "enrolar",
  "poker", "aguila", "club", "corona", "coronita", "stella", "artois", "costena", "bacana", "budweiser", "heineken", "tecate", "modelo", "michelob", "redd", "smirnoff", "four", "loko", "antioqueno", "caldas", "mitica", "buchanan", "baileys",
  "lucky", "luckye", "malboro", "boston", "lym", "starlite", "vuse", "ocb", "lion", "swisslite", "clipper", "tokay", "blunt",
]);

// Pedidos genéricos: palabras que no nombran un producto sino una familia. Buscarlas tal cual trae
// cosas sin relación ("dulce" → maíz dulce), así que se le devuelven al asistente los tipos por los que
// debe preguntar. Cada tipo es una palabra que sí funciona en la búsqueda.
const GENERICOS = [
  [["dulce", "golosina", "antojo", "confite"], ["Chocolatina", "Gomas", "Galletas"]],
  [["mecato", "pasaboca", "snack", "picar", "paquete"], ["Papas", "Maní", "Doritos"]],
  [["bebida", "tomar", "beber", "refresco", "liquido", "sed"], ["Gaseosa", "Jugo", "Agua"]],
  [["trago", "licor", "alcohol"], ["Cerveza", "Aguardiente", "Ron"]],
  [["aseo", "limpieza", "limpiar"], ["Jabón", "Detergente", "Papel higiénico"]],
  [["desayuno", "desayunar"], ["Pan", "Huevos", "Leche"]],
  [["almuerzo", "almorzar", "cocinar", "comida", "cena"], ["Arroz", "Fríjol", "Atún"]],
  [["bebe", "nene", "recien", "nacido"], ["Pañal Winny", "Pañitos", "Compota"]],
  [["mascota", "perro", "gato", "perrito", "gatico"], ["Dog Chow", "Alimento gato", "Arena"]],
];
const RELLENO = new Set(["un", "una", "unos", "unas", "algo", "alguna", "algun", "de", "del", "para", "el", "la", "los", "las", "que", "quiero", "necesito", "tienes", "tienen", "hay", "me", "das", "dame", "venden", "por", "favor", "porfa", "y", "o", "a", "con", "cosa", "cosas", "rico", "rica", "bueno", "mi", "mis", "tu", "hacer", "preparar"]);

/** Si lo pedido es una familia y no un producto, los tipos por los que hay que preguntar; si no, null. */
export function pedidoGenerico(consulta) {
  const palabras = norm(consulta).split(" ").filter((t) => t && !RELLENO.has(t)).map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
  if (!palabras.length) return null;
  const familia = GENERICOS.find(([claves]) => palabras.every((t) => claves.includes(t)));
  return familia
    ? { pedido_generico: true, tipos: familia[1], instruccion: "El cliente no dijo qué producto quiere. No ofrezcas productos todavía: pregúntale qué tipo busca y ofrécele estos tipos con ofrecer_botones. Cuando elija uno, búscalo con esa palabra." }
    : null;
}

// Para acompañar: qué ofrecerle al cliente según lo que lleva. Cada regla es
// [lo que dispara la sugerencia, qué buscar para ofrecer, cómo decirlo]. Gana la primera regla que
// coincida con algo del pedido y cuyo acompañante no esté ya en él.
const ACOMPANAR = [
  [/ (cerveza|aguardiente|ron|whisky|vodka|tequila|vino|refajo) /, ["papa", "mani"], "algo de picar para acompañar"],
  [/ (papa|papas|doritos|detodito|cheetos|mani|manimoto|chocolatina|galleta|galletas|goma|gomas|natuchips|choclitos|tostacos|margarita|rizadas|patacon|golpe|popetas) /, ["gaseosa", "jugo"], "algo de tomar para acompañar", true],
  [/ (pollo|carne|cerdo|costilla|pechuga|chorizo|tocineta) /, ["arroz", "aceite"], "algo para la preparación"],
  [/ (arroz|frijol|frijoles|lenteja|lentejas|pasta|spaguetti|spaghetti) /, ["aceite", "atun"], "algo para completar la comida"],
  [/ (pan|arepa|arepas|tostada|tostadas) /, ["queso", "mantequilla"], "algo para acompañar el pan o la arepa"],
  [/ (huevo|huevos) /, ["pan", "arepa"], "algo para acompañar los huevos"],
  [/ (leche|cafe|chocolate|milo|chocolisto) /, ["pan", "galleta"], "algo para acompañar"],
  [/ (gaseosa|jugo|coca|pepsi|sprite|colombiana|postobon|quatro) /, ["papa", "chocolatina"], "algo de picar para acompañar"],
  [/ panal (winny|huggies|pequenin|piscina) /, ["panitos"], "pañitos para el bebé"],
  [/ (whiskas|donkat|felix|gato|gatos|cat chow|gatitos) /, ["arena"], "arena para el gato"],
  [/ (detergente|jabon|blanqueador|suavizante|fabuloso|lavaloza) /, ["esponja", "papel higienico"], "algo más para el aseo"],
];

/**
 * Lo que se le puede ofrecer al cliente para acompañar lo que lleva: hasta 2 productos, los más vendidos
 * de su tipo, disponibles y que no estén ya en el pedido. null si no hay nada que proponer.
 * @param {{sku: string, name: string}[]} items
 */
export function paraAcompanar(items, agotados = {}) {
  const nombres = items.map((i) => ` ${norm(i.name)} `);
  const enPedido = new Set(items.map((i) => i.sku));
  for (const [dispara, ofrecer, frase, sinFrescos] of ACOMPANAR) {
    // sinFrescos: la regla no mira lo que se vende fresco por libra.
    if (!nombres.filter((n) => !sinFrescos || !n.includes(" libra ")).some((n) => dispara.test(n))) continue;
    // La primera regla que aplica decide. Si ya lleva algo de ese tipo, no se le ofrece nada.
    if (ofrecer.some((q) => nombres.some((n) => n.includes(` ${q}`)))) return null;
    const productos = ofrecer.map((q) => buscar(q, agotados).find((p) => p.disponible && !enPedido.has(p.sku))).filter(Boolean).slice(0, 2);
    if (productos.length) return {
      ofrecer: frase,
      productos: productos.map((p) => ({ sku: p.sku, nombre: p.nombre, precio: p.precio })),
      instruccion: "Propónselo ahora, una sola vez y en una frase natural que conecte con lo que lleva. Usa ofrecer_botones con estos productos (título = nombre completo, detalle = precio, corto = nombre abreviado) y una última opción \"No, gracias\". Si dice que no o no responde a eso, sigue con el pedido y no vuelvas a ofrecer acompañantes.",
    };
  }
  return null;
}

// Cómo lo dice el cliente y cómo está escrito en el catálogo. Una "media" de cigarrillos, de cualquier
// marca, es la cajetilla de 10; y en Siigo la marca quedó escrita "Malboro".
const MARCAS_CIGARRILLO = new Set(["cigarrillo", "cigarrillos", "cigarro", "cigarros", "pucho", "lucky", "luckyes", "marlboro", "malboro", "boston", "lym", "starlite", "rothmans", "chesterfield", "kool", "belmont"]);
const VACIAS = new Set(["de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "con", "por", "para", "x"]);
function palabrasDeTienda(palabras) {
  const deCigarrillos = palabras.some((t) => MARCAS_CIGARRILLO.has(t));
  // Las palabras de relleno ("media libra de tomate") no cuentan para buscar, salvo que no haya otras.
  const utiles = palabras.filter((t) => !VACIAS.has(t));
  return (utiles.length ? utiles : palabras).map((t) => (t === "marlboro" ? "malboro" : deCigarrillos && (t === "media" || t === "medias") ? "cajetilla" : t));
}

/** Misma búsqueda por palabras que usa la página. */
export function buscar(consulta, agotados = {}, cuantos = 8) {
  const palabras = palabrasDeTienda(norm(consulta).split(" ").filter(Boolean)).map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
  if (!palabras.length) return [];
  const minimo = Math.ceil(palabras.length * 0.5);
  const pideRestringido = palabras.some((t) => PIDE_RESTRINGIDO.has(t));
  const hallados = [];
  for (const p of LISTA) {
    if (p.restringido && !pideRestringido) continue;
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

/**
 * Subtotal, domicilio y total de un pedido. Mientras se arma, el domicilio es el de la hora (o el de la
 * hora programada). Desde que el cliente lo cierra, la tarifa queda fija para ese pedido: que pague, se
 * despache o se entregue en otra franja no se la cambia. Solo cambia si pide otra hora de entrega.
 */
export function totalesDe(pedido) {
  const subtotal = pedido.items.reduce((s, i) => s + i.qty * i.price, 0);
  if (subtotal === 0) return { subtotal: 0, domicilio: 0, total: 0 };
  // domicilioFijo y bolsaFija: lo que se cobró al cerrar el pedido. Los pedidos cerrados antes de que
  // existieran esos datos los deducen de su total (y no llevaban bolsa).
  const legado = pedido.domicilioFijo == null && pedido.status !== "armando" && pedido.total > subtotal;
  const calculado = totales(pedido.items, momentoDe(pedido));
  const domicilio = pedido.domicilioFijo ?? (legado ? pedido.total - subtotal : calculado.domicilio);
  const bolsa = pedido.bolsaFija ?? (legado || pedido.domicilioFijo != null ? 0 : calculado.bolsa);
  return { subtotal, domicilio, bolsa, total: subtotal + domicilio + bolsa };
}

/** Lo que el asistente necesita saber del pedido, sin la foto del comprobante. */
export function resumen(pedido) {
  return {
    estado: pedido.status,
    items: pedido.items.map((i) => ({ sku: i.sku, nombre: i.name, cantidad: i.qty })),
    ...totalesDe(pedido),
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
  let entrega = ahora.encargo ? `Es un encargo: ${ahora.encargo.replace("Encargo: ", "")}. No prometas entrega antes.` : "Llega en máximo 15 minutos.";
  let encargo = ahora.encargo;
  // Entrega programada: se vuelve a revisar al cerrar, por si la hora ya pasó mientras armaban el pedido.
  if (pedido.programado) {
    const revisado = revisarProgramado(pedido.programado.ts);
    if (revisado.error) throw new Error(`${revisado.error} Pídele otra hora al cliente o deja el pedido para entrega inmediata.`);
    pedido.programado = revisado;
    entrega = `La entrega quedó programada para ${revisado.texto}. No prometas entrega antes de esa hora.`;
    encargo = `Programado: ${revisado.fijo}`;
  }
  const { total, domicilio, bolsa } = totalesDe(pedido);
  Object.assign(pedido, { total, encargo, domicilioFijo: domicilio, bolsaFija: bolsa });

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
