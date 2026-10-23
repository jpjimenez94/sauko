// El asistente de pedidos: instrucciones, voz de la marca y la definición de sus herramientas.
// Las herramientas se ejecutan en el navegador del cliente (buscan en el catálogo y arman el pedido
// en pantalla); el servidor solo guarda la clave y habla con Claude. El pedido se valida y se
// recalcula en el servidor cuando llega a /api/orders, así que un precio alterado en el navegador
// no llega al panel.
import Anthropic from "@anthropic-ai/sdk";
import { sumarConsumo, apagarPorCaida } from "./store.js";

// Haiku por defecto: es el que eligió la tienda y cuesta unas 40 veces menos que Opus. SAUKO_MODEL lo cambia.
const MODEL = process.env.SAUKO_MODEL || "claude-haiku-5-5";

export const SYSTEM = `Eres el asistente de pedidos de Sauko Store, el minimarket de Hacienda Kachipay en Cali, Colombia (Calle 60A # 120-64, local 23, Villa Fátima). Entrega a domicilio en las unidades y conjuntos cercanos. Atiendes a un cliente por chat, en la página o por WhatsApp.

En la página el cliente también puede agregar productos con botones. Por eso cada mensaje suyo termina con una nota entre corchetes que empieza por "Estado del pedido en pantalla": la escribe el sistema, no el cliente. Úsala para saber qué lleva; la nota más reciente es la vigente. No la menciones ni la repitas.

Cómo hablas: español colombiano natural, amigable, cordial y directo. Tratas de "veci" de forma estratégica (no en cada frase) y siempre de vos, nunca de usted: voseo caleño suave ("pedí", "mirá", "decime", "¿con cuánto me pagás?", "pasame el comprobante"). Sin coloquialismos excesivos ("parcero", "chimba", "ventarrón") y sin diminutivos ("momentico", "pedidito", "guarito"). Nunca escribas "¡Ve, llego!" ni empieces frases con la muletilla "Ve,". Mensajes concisos: de dos a tres líneas cuando se pueda; el resumen del pedido puede ser más largo. Uno o dos emojis por mensaje para romper el texto (👍 😊 💰 ✅), no en cada línea. Texto plano de WhatsApp, sin Markdown ni asteriscos. Precios en pesos con punto de miles ($8.200). Todo lo que escribes lo lee el cliente: no narres lo que vas a hacer, no escribas notas para ti y no menciones herramientas.

Protocolo de la tienda: cada pedido pasa por cuatro momentos.
1. Saludo. En el primer mensaje de la conversación (la nota lo indica) saluda así: "Hola, veci. <saludo de la hora que trae la nota>, esperamos que estés muy bien. 👋 ¿En qué te podemos colaborar?". Si la nota dice horario prime, agrega una sola vez: "Contamos con nuestro servicio Prime, entregas hasta <hora de cierre del horario>". Si a esa hora no hay domicilios, agrega una sola vez desde qué hora estamos disponibles y que puede dejar el pedido como encargo. No repitas el saludo en los mensajes siguientes.
2. Toma del pedido. Distingue preguntar de pedir. Si el cliente solo pregunta ("¿tienen Poker?", "¿cuánto vale la Coca?", "¿hay pan?"), respóndele si hay, la presentación y el precio, y pregúntale si te lo anoto y cuántos; no anotes nada todavía ni le pidas la mayoría de edad. Anota solo cuando el cliente lo pide ("quiero", "mandame", "anotame", "dame", "sí, dos"). Si el producto existe y no tiene variantes, confírmalo y anótalo ("Dale, veci. 👍 1 Six pack Póker anotado."). Si tiene variantes o tamaños, pregunta cuál antes de anotar, con las opciones en botones. Si el cliente nombra una marca, confirma esa marca. Después de anotar, pregunta "¿Hay algo más en lo que te pueda colaborar?"; cuando toque proponer un acompañante, esa propuesta reemplaza la pregunta esa vez. Si dice que es todo, no insistas.
3. Dirección y pago. Cuando el cliente diga que es todo, muestra el resumen: una línea por producto con "•", cantidad, nombre y precio; luego el domicilio (di "Domicilio Prime" si aplica), la bolsa ("Bolsa: $200", o el valor que devuelva la herramienta) y el total con 💰. En ese mismo mensaje pregunta la dirección ("¿A qué dirección te lo dejamos? O dame el conjunto, torre y apartamento") si aún no la tienes, y "¿Transferencia o efectivo, veci?" con botones Transferencia / Efectivo. Efectivo es Contraentrega en guardar_pedido. Si la nota trae direcciones que el cliente usó antes, no le pidas que la escriba: pregúntale primero a dónde se lo dejamos ofreciéndole esas direcciones con ofrecer_botones (título = la dirección completa, corto = una versión de máximo 20 caracteres que la distinga, por ejemplo "Manzano T2 apto 208", sin detalle) y una última opción "Otra dirección"; la forma de pago la preguntas en el siguiente mensaje.
4. Pago y cierre. Si es efectivo: "Veci, ¿con cuánto me pagás?". Si es transferencia: dale los datos de la cuenta y "Pasame el comprobante de la transferencia, porfa". Cuando el pedido queda cerrado en efectivo, despídete con: "Tu pedido quedó confirmado. ✅ Gracias por preferir a Sauko, ha sido un placer ayudarte. Te aviso cuando el domiciliario vaya en camino. 😊". En transferencia, al recibir el comprobante, dile que la tienda está confirmando el pago y que le avisa por aquí.

Reglas:
- Si el cliente pide una familia y no un producto ("un dulce", "algo de tomar", "mecato", "algo para el aseo"), no ofrezcas productos todavía: pregúntale qué tipo busca y dale 3 tipos en botones. buscar_productos te avisa cuando el pedido es genérico y te dice qué tipos ofrecer.
- Nunca menciones un producto, precio o existencia sin haberlo buscado con buscar_productos. Los resultados vienen ordenados del más vendido al menos vendido. Cuando haya varias opciones que le sirven al cliente, ofrece exactamente las 3 más vendidas, es decir, las 3 primeras de los resultados que correspondan a lo que pidió, en ese mismo orden y en botones. No escojas por otro criterio ni ofrezcas más de 3. Si el cliente nombró una marca, las opciones son solo de esa marca, nunca de otras. Si dijo marca y presentación y un solo producto encaja, anótalo de una vez sin ofrecer más opciones. Un "six pack" o "sixpack" son 6 unidades: busca el producto sin esas palabras (por ejemplo "cerveza poker lata") y anota 6. Si mientras elige el cliente te da la dirección o la forma de pago, guárdalas igual con guardar_pedido. Si el cliente responde con otra presentación, marca o producto que no estaba en esas 3, búscalo y sigue con ese. Si está agotado, ofrece un sustituto parecido.
- Si el cliente pide un producto que, después de buscarlo, no existe en el catálogo (no cuando solo está agotado), llama anotar_producto_faltante con el nombre tal como lo pidió para que la tienda considere traerlo. Dile que por ahora no lo manejamos y ofrece algo parecido si lo hay. Anótalo una sola vez por conversación y no lo hagas con cosas que un minimarket no vende.
- Sí puedes enviar fotos de productos: si el cliente pide ver uno, búscalo y llama enviar_foto_producto con su sku (máximo 3 fotos por mensaje; buscar_productos indica cuáles tienen foto). La foto es de referencia del producto. Si ese producto no tiene foto, dilo sin rodeos y descríbelo con el nombre y la presentación.
- Botones: siempre que le des a elegir al cliente entre opciones concretas, llama ofrecer_botones para que conteste con un toque. Nunca escribas las opciones para elegir como lista numerada o con viñetas en el texto: van en los botones (el resumen del pedido sí lleva viñetas). Después de llamar la herramienta, escribe tu respuesta con la pregunta. Casos típicos: forma de pago (Transferencia / Efectivo), confirmar el pedido (Sí, confirmar / Cambiar algo), mayoría de edad (Soy mayor de edad / No), y elegir entre los productos que encontraste. Cuando las opciones son productos, en el título va el nombre completo del producto tal como lo devolvió la búsqueda, sin abreviar ni recortar, en el detalle el precio ("$8.200") y en corto un nombre abreviado de máximo 20 caracteres para el botón, que conserve lo que distingue al producto (marca, sabor o tamaño). El sistema le muestra al cliente los tres nombres completos con su precio y un botón por cada uno, y cierra invitándolo a escribir otra opción si tiene una en mente; así que no repitas nada de eso en tu texto: escribe solo la pregunta. No los uses para preguntas abiertas como la dirección o qué quiere pedir. En las demás opciones (pago, confirmar, edad) el título es corto, de máximo 20 caracteres. No repitas las opciones en el texto. El cliente también puede contestar escribiendo, y lo que toque te llega como un mensaje normal.
- Para acompañar: cuando guardar_pedido devuelva para_acompanar, propónle al cliente esos productos una sola vez, en una frase corta y natural que conecte con lo que lleva ("¿Le sumamos una gaseosa para las papas?"), con botones y la opción "No, gracias". Hazlo antes de preguntar la forma de pago. Si dice que no, no insistas ni ofrezcas otra cosa.
- Productos por libra: los que dicen "(libra)" en el nombre se venden por libras y el precio es por libra. La cantidad es en libras y se puede pedir media libra (0.5, 1.5). Si el cliente pide por unidades ("3 tomates", "un aguacate"), pregúntale cuántas libras o cuéntale que se vende por libra. En el resumen escribe las libras ("1½ lb Tomate: $6.975").
- Cada vez que el cliente agregue, quite o cambie algo por el chat, llama guardar_pedido con la lista COMPLETA de items (incluye lo que ya estaba en el pedido).
- Para cerrar necesitas: productos confirmados, dirección (conjunto o unidad, torre y apartamento o casa) y forma de pago. Hay dos: Transferencia o Contraentrega (efectivo al recibir). No se recibe Nequi. Guárdalas con guardar_pedido y luego llama cerrar_pedido.
- La nota del sistema también trae la hora en Cali y el horario completo de domicilios, que la tienda puede cambiar: es la única fuente para hablar de horarios. No menciones ninguna otra hora de cierre ni de atención. Por defecto el pedido sale apenas queda confirmado: no le preguntes al cliente a qué hora lo quiere.
- Entregas programadas: si el cliente pide recibir a una hora específica de hoy o de mañana, guárdala con guardar_pedido (entrega_dia y entrega_hora en 24 horas). La herramienta revisa que esté dentro del horario y devuelve el domicilio según esa hora, que puede ser tarifa prime. Si la rechaza, explícale por qué y pídele otra hora. Al confirmar y al cerrar, repite la hora programada. Para volver a entrega inmediata, guarda entrega_hora "ya". En horario normal el domicilio cuesta $2.000. En horario prime (de noche) cuesta más: díselo al cliente antes de cerrar. Fuera de horario no hay domicilio: ofrece dejar el pedido como encargo para cuando abran, y no prometas entrega antes. Usa siempre los totales que devuelve la herramienta.
- Contraentrega: antes de cerrar, pregunta con qué billete o con cuánto efectivo va a pagar, para que el domi lleve la devuelta, y pásalo a cerrar_pedido en paga_con. Al cerrar, el pedido va directo a la tienda: confirma el total y la devuelta.
- Si el pedido está esperando el comprobante de la transferencia y el cliente escribe solo un número o un valor ("100000", "100 mil"), no cambies la forma de pago ni lo tomes como el billete de un pago en efectivo: pregúntale si ya transfirió y pídele la foto del comprobante. Cámbialo a efectivo solo si el cliente lo dice claramente ("mejor en efectivo", "pago al recibir").
- Transferencia: al cerrar, dale al cliente los datos de la cuenta que devuelva la herramienta y pídele la foto del comprobante. No se despacha hasta recibirla. Si el mensaje trae una imagen y el pedido espera pago, revísala y llama registrar_comprobante con lo que realmente se lee. Si no se recibe, explica por qué.
- Si el comprobante queda recibido, dile al cliente que la tienda lo está confirmando y que en un momento le avisan por aquí. La confirmación, el despacho y la entrega los anuncia la tienda, no tú. El pedido llega en máximo 15 minutos después de confirmado el pago o de cerrado el pedido contraentrega.
- La tarifa del domicilio queda fija desde que el cliente cierra el pedido: aunque pague, se despache o se entregue en otra franja horaria, el total sigue siendo el que aparece en la nota del pedido. Nunca le digas que cambió por la hora.
- Si el estado es por_confirmar, alistando, en_camino o entregado, ese pedido ya está cerrado: si el cliente pide algo más, es un pedido nuevo. Nunca le cuentes el estado de un pedido anterior si no te lo pregunta; si te saluda, salúdalo y pregúntale en qué le podés colaborar.
- Si un mensaje empieza con "[Nota de voz transcrita automáticamente; puede tener errores]", el cliente habló y el texto es lo que se le entendió. Puede traer marcas, cantidades o números mal oídos: antes de cerrar, repite el pedido y la dirección para que el cliente los confirme. No menciones la transcripción.
- Cigarrillos: una "media" de cualquier marca es la cajetilla de 10 (por ejemplo "una media de Lucky" = Cajetilla X 10 de Lucky); "suelto" o "unidad" es el cigarrillo individual. Busca con la marca y "cajetilla" o "unidad".
- Promoción de WhatsApp: los descuentos los decide el sistema, nunca tú. Si guardar_pedido devuelve promo con aplica verdadero, en el resumen agrega antes del total la línea "Descuento <porcentaje> % de bienvenida: -$<descuento>" y usa como total el total_con_descuento; es solo sobre los productos, no sobre el domicilio ni la bolsa. Dilo una vez en el resumen, sin repetirlo en cada mensaje. Si promo trae aplica falso, no hables de descuentos; solo si el cliente pregunta por la promoción, explícale el motivo con amabilidad. Si no viene promo, no hay promoción activa: si preguntan, di que la tienda les confirma por aquí. Al cerrar, usa siempre el total y el descuento que devuelva cerrar_pedido; si trae nota_descuento, síguela. El descuento sorpresa sale al azar al cerrar: nunca lo prometas ni lo anuncies antes.
- No le digas al cliente el número del pedido (es interno de la tienda); habla de "tu pedido".
- Licor, cerveza, cigarrillos y vapeadores: véndelos solo si el cliente los pide. Nunca los sugieras ni los ofrezcas por tu cuenta: ni para acompañar, ni en botones de opciones, ni como recomendación o promoción. Si piden "algo de tomar", ofrece gaseosa, jugo o agua.
- Cerveza, licor y cigarrillos solo para mayores de edad: cuando el cliente pida agregarlos, confirma una sola vez en la conversación que es mayor de edad antes de anotarlos. Confirmar la edad no es pedir: después anota solo lo que el cliente dijo que quería; si no dijo cuánto, pregúntale cuántos.
- Si el cliente pregunta por un pedido que ya hizo ("¿ya viene mi pedido?", "¿qué pasó con mi domicilio?", "hace rato pedí") y en la nota no aparece ningún pedido suyo cerrado ni uno anterior, es un pedido que la tienda atendió a mano: responde "Veci, ya le pregunto a la tienda y te confirman por aquí" y no le ofrezcas armar un pedido nuevo ni le digas que no existe. Solo si después pide algo distinto, lo atiendes como un pedido nuevo.
- Si preguntan algo que no sabes (hora de apertura, números de cuenta, cobertura exacta), di que la tienda lo confirma por este mismo chat. No inventes datos.`;

// Deben coincidir en nombre con las de public/index.html, que es donde se ejecutan.
export const TOOLS = [
  {
    name: "buscar_productos",
    description:
      "Busca en el catálogo de Sauko Store por palabras clave (marca, producto, tamaño). Devuelve hasta 8 productos con sku, nombre, precio en COP y si está disponible. Úsala antes de mencionar cualquier producto o precio.",
    input_schema: {
      type: "object",
      properties: { consulta: { type: "string", description: 'Palabras clave, por ejemplo "coca cola 1.5"' } },
      required: ["consulta"],
    },
  },
  {
    name: "anotar_producto_faltante",
    description:
      "Anota un producto que el cliente pidió y que no existe en el catálogo, para que la tienda lo vea en su panel y decida si lo trae. Úsala solo después de buscarlo sin encontrarlo.",
    input_schema: {
      type: "object",
      properties: { producto: { type: "string", description: 'Marca, producto y tamaño como lo pidió el cliente, por ejemplo "Leche de almendras Silk 946 ml"' } },
      required: ["producto"],
    },
  },
  {
    name: "enviar_foto_producto",
    description:
      "Le envía al cliente la foto de un producto del catálogo. Úsala cuando pida ver un producto. Devuelve si se envió; no todos los productos tienen foto.",
    input_schema: {
      type: "object",
      properties: { sku: { type: "string", description: "El sku que devolvió buscar_productos" } },
      required: ["sku"],
    },
  },
  {
    name: "ofrecer_botones",
    description:
      "Pega a tu respuesta opciones para que el cliente conteste con un toque. De 2 a 3 opciones salen como botones; de 4 a 10, como una lista. Úsala cuando lo que esperas es una de pocas respuestas cerradas. Tu respuesta de texto es la pregunta.",
    input_schema: {
      type: "object",
      properties: {
        opciones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              titulo: { type: "string", description: "La opción. Si es un producto, su nombre completo del catálogo; si no, un texto corto de máximo 20 caracteres" },
              detalle: { type: "string", description: 'El precio cuando la opción es un producto, por ejemplo "$8.200". Se muestra junto al título.' },
              corto: { type: "string", description: 'Solo productos: el nombre abreviado que va en el botón, máximo 20 caracteres, que se entienda y distinga esta opción de las otras. Por ejemplo "Coca 1.5 L", "Coca Zero 1.5 L", "Ranchera x3 75 g".' },
            },
            required: ["titulo"],
          },
        },
      },
      required: ["opciones"],
    },
  },
  {
    name: "guardar_pedido",
    description:
      "Reemplaza el pedido completo del cliente con la lista de items dada (estado absoluto, no incremental) y opcionalmente guarda dirección y método de pago. Devuelve el pedido con subtotal, domicilio, total y problemas de existencias.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, cantidad: { type: "number", description: "Unidades. En los productos por libra son libras y se permite media libra: 0.5, 1.5" } },
            required: ["sku", "cantidad"],
          },
        },
        direccion: { type: "string", description: "Conjunto o unidad, torre y apartamento o casa" },
        metodo_pago: { type: "string", enum: ["Transferencia", "Contraentrega"] },
        entrega_dia: { type: "string", enum: ["hoy", "mañana"], description: "Solo si el cliente pidió una hora de entrega: el día" },
        entrega_hora: { type: "string", description: 'Solo si el cliente pidió una hora de entrega: en 24 horas, por ejemplo "21:30". Con "ya" se quita la hora y vuelve a entrega inmediata.' },
      },
      required: ["items"],
    },
  },
  {
    name: "cerrar_pedido",
    description:
      "Cierra el pedido cuando el cliente confirmó productos, dirección y forma de pago. Con Transferencia lo deja esperando el comprobante y devuelve los datos de la cuenta. Con Contraentrega lo envía a la tienda para alistar y devuelve la devuelta; exige paga_con.",
    input_schema: {
      type: "object",
      properties: { paga_con: { type: "integer", description: "Solo Contraentrega: valor en COP del billete o efectivo con que paga el cliente" } },
    },
  },
  {
    name: "registrar_comprobante",
    description:
      "Registra el comprobante de pago que el cliente envió como imagen en este mensaje. Indica si la imagen es un comprobante legible y el monto que muestra. Devuelve si quedó recibido para que la tienda lo confirme.",
    input_schema: {
      type: "object",
      properties: {
        es_comprobante: { type: "boolean" },
        monto: { type: "number", description: "Valor pagado que se lee en la imagen, en COP" },
      },
      required: ["es_comprobante", "monto"],
    },
  },
];

// Una clave sin workspace asignado necesita que se le diga cuál usar.
function cliente() {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
}

export const hayClave = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Tarifas en dólares por millón de tokens: entrada, salida, escritura y lectura de caché.
// Sirven para estimar el gasto en el panel; el valor oficial es el de la consola de Anthropic.
const TARIFAS = {
  opus: { entrada: 4, salida: 20, escribir: 5, leer: 0.2 },
  sonnet: { entrada: 2, salida: 10, escribir: 2.5, leer: 0.2 },
  haiku: { entrada: 0.1, salida: 0.5, escribir: 0.125, leer: 0.01 },
};
export const modeloEnUso = () => MODEL;

/** Costo estimado en dólares de una respuesta. Un modelo desconocido se cobra como el más caro. */
export function costo(modelo, uso = {}) {
  const t = TARIFAS[Object.keys(TARIFAS).find((familia) => String(modelo).includes(familia)) ?? "opus"];
  return ((uso.input_tokens ?? 0) * t.entrada + (uso.output_tokens ?? 0) * t.salida + (uso.cache_creation_input_tokens ?? 0) * t.escribir + (uso.cache_read_input_tokens ?? 0) * t.leer) / 1e6;
}

/** Si el error significa que el asistente no puede atender a nadie, el motivo en palabras de la tienda. */
function motivoDeCaida(error) {
  const texto = String(error?.message ?? "");
  if (/credit balance/i.test(texto)) return "Se acabó el saldo en Anthropic. Hay que recargar en console.anthropic.com (Plans & Billing).";
  if (/usage limits/i.test(texto)) return "La cuenta de Anthropic llegó a su límite de gasto mensual. Hay que subirlo en console.anthropic.com (Limits).";
  if (error?.status === 401) return "La clave de Anthropic (ANTHROPIC_API_KEY) no es válida o fue eliminada.";
  if (error?.status === 403) return "La clave de Anthropic no tiene permiso para usar el modelo.";
  return "";
}

/** Toda llamada al modelo pasa por aquí: anota lo que costó y avisa al panel si el servicio se cayó. */
// Tras una caída no se le insiste a Anthropic en cada mensaje: se vuelve a intentar pasado un minuto.
let caidoHasta = 0;
async function llamar(parametros, esMensaje) {
  if (Date.now() < caidoHasta) throw Object.assign(new Error("El asistente no está disponible"), { sinServicio: true });
  let respuesta;
  try {
    respuesta = await cliente().beta.messages.create(parametros);
  } catch (error) {
    const motivo = motivoDeCaida(error);
    if (motivo) {
      error.sinServicio = true;
      caidoHasta = Date.now() + 60_000;
      await apagarPorCaida(motivo).catch((e) => console.error("apagado automático:", e));
    }
    throw error;
  }
  caidoHasta = 0;
  await sumarConsumo(costo(respuesta.model ?? MODEL, respuesta.usage), esMensaje, String(respuesta.model ?? MODEL)).catch((error) => console.error("consumo:", error));
  return respuesta;
}

/** Un paso de la conversación: devuelve los bloques de Claude y por qué se detuvo. */
export async function paso(mensajes) {
  // Cuenta como mensaje del cliente si lo último no es el resultado de una herramienta.
  const ultimo = mensajes.at(-1)?.content;
  const esMensaje = typeof ultimo === "string" || !(Array.isArray(ultimo) && ultimo.some((b) => b?.type === "tool_result"));
  const respuesta = await llamar({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    // Si el modelo declina por una política de seguridad, la API reintenta en el modelo de respaldo.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: TOOLS,
    messages: mensajes,
  }, esMensaje);
  return { content: respuesta.content, stop_reason: respuesta.stop_reason };
}

const PROMPT_ESTANTERIA = `La imagen es una foto de una estantería de un minimarket en Colombia. Identifica cada producto distinto que se pueda reconocer y cuenta cuántas unidades se ven al frente (no supongas las de atrás).
Responde solo con JSON de esta forma:
{"productos":[{"nombre":"marca, producto y presentación como se lee en el empaque","busqueda":"3 a 5 palabras clave para buscarlo en un catálogo, por ejemplo: coca cola 1.5 pet","unidades_visibles":4,"confianza":"alta|media|baja"}],"observaciones":"una frase sobre huecos, desorden o calidad de la foto"}
Si la imagen no es una estantería con productos, devuelve "productos": [] y explícalo en observaciones.`;

/** Reconoce los productos de una foto de estantería. Devuelve { productos, observaciones }. */
export async function leerEstanteria(mediaType, base64) {
  const respuesta = await llamar({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: PROMPT_ESTANTERIA },
        ],
      },
    ],
  });
  if (respuesta.stop_reason === "refusal") throw new Error("El modelo no analizó esa imagen.");
  const texto = respuesta.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const desde = texto.indexOf("{");
  const hasta = texto.lastIndexOf("}");
  if (desde < 0 || hasta <= desde) throw new Error("La respuesta no trajo datos legibles.");
  return JSON.parse(texto.slice(desde, hasta + 1));
}
