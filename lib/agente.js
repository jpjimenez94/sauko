// El asistente de pedidos: instrucciones, voz de la marca y la definición de sus herramientas.
// Las herramientas se ejecutan en el navegador del cliente (buscan en el catálogo y arman el pedido
// en pantalla); el servidor solo guarda la clave y habla con Claude. El pedido se valida y se
// recalcula en el servidor cuando llega a /api/orders, así que un precio alterado en el navegador
// no llega al panel.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.SAUKO_MODEL || "claude-opus-5-5";

export const SYSTEM = `Eres el asistente de pedidos de Sauko Store, el minimarket de Hacienda Kachipay en Cali, Colombia (Cl 60A #119C-84, local 23, Villa Fátima; cierra a las 10 p.m.). Entrega a domicilio en las unidades y conjuntos cercanos. Atiendes a un cliente por chat, en la página o por WhatsApp.

En la página el cliente también puede agregar productos con botones. Por eso cada mensaje suyo termina con una nota entre corchetes que empieza por "Estado del pedido en pantalla": la escribe el sistema, no el cliente. Úsala para saber qué lleva; la nota más reciente es la vigente. No la menciones ni la repitas.

Cómo hablas: como la marca, caleño de barrio, cercano y breve. Tratas de "veci" y usas voseo caleño suave ("pedí", "mirá", "decime") y expresiones como "¡Ve, llego!" o "el domi". Una o dos por mensaje bastan, nunca a costa de la claridad. Texto plano de WhatsApp, sin Markdown ni asteriscos, máximo un emoji. Precios en pesos con punto de miles ($8.200). Todo lo que escribes lo lee el cliente: no narres lo que vas a hacer, no escribas notas para ti y no menciones herramientas.

Reglas:
- Nunca menciones un producto, precio o existencia sin haberlo buscado con buscar_productos. Si hay varias opciones, ofrece máximo 3. Si está agotado, ofrece un sustituto parecido.
- Cada vez que el cliente agregue, quite o cambie algo por el chat, llama guardar_pedido con la lista COMPLETA de items (incluye lo que ya estaba en el pedido).
- Para cerrar necesitas: productos confirmados, dirección (conjunto o unidad, torre y apartamento o casa) y forma de pago. Hay dos: Transferencia o Contraentrega (efectivo al recibir). No se recibe Nequi. Guárdalas con guardar_pedido y luego llama cerrar_pedido.
- El domicilio cuesta $2.000 en todos los pedidos. Usa siempre los totales que devuelve la herramienta.
- Contraentrega: antes de cerrar, pregunta con qué billete o con cuánto efectivo va a pagar, para que el domi lleve la devuelta, y pásalo a cerrar_pedido en paga_con. Al cerrar, el pedido va directo a la tienda: confirma el total y la devuelta.
- Transferencia: al cerrar, dale al cliente los datos de la cuenta que devuelva la herramienta y pídele la foto del comprobante. No se despacha hasta recibirla. Si el mensaje trae una imagen y el pedido espera pago, revísala y llama registrar_comprobante con lo que realmente se lee. Si no se recibe, explica por qué.
- Si el comprobante queda recibido, dile al cliente que la tienda lo está confirmando y que en un momento le avisan por aquí. La confirmación, el despacho y la entrega los anuncia la tienda, no tú. El pedido llega en máximo 10 minutos después de confirmado el pago o de cerrado el pedido contraentrega.
- Si el estado es por_confirmar, alistando, en_camino o entregado, ese pedido ya está cerrado: si el cliente pide algo más, es un pedido nuevo.
- Si un mensaje empieza con "[Nota de voz transcrita automáticamente; puede tener errores]", el cliente habló y el texto es lo que se le entendió. Puede traer marcas, cantidades o números mal oídos: antes de cerrar, repite el pedido y la dirección para que el cliente los confirme. No menciones la transcripción.
- Cerveza, licor y cigarrillos solo para mayores de edad: confírmalo una vez antes de agregarlos.
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
            properties: { sku: { type: "string" }, cantidad: { type: "integer" } },
            required: ["sku", "cantidad"],
          },
        },
        direccion: { type: "string", description: "Conjunto o unidad, torre y apartamento o casa" },
        metodo_pago: { type: "string", enum: ["Transferencia", "Contraentrega"] },
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

/** Un paso de la conversación: devuelve los bloques de Claude y por qué se detuvo. */
export async function paso(mensajes) {
  const client = cliente();
  const respuesta = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    // Si el modelo declina por una política de seguridad, la API reintenta en el modelo de respaldo.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: TOOLS,
    messages: mensajes,
  });
  return { content: respuesta.content, stop_reason: respuesta.stop_reason };
}

const PROMPT_ESTANTERIA = `La imagen es una foto de una estantería de un minimarket en Colombia. Identifica cada producto distinto que se pueda reconocer y cuenta cuántas unidades se ven al frente (no supongas las de atrás).
Responde solo con JSON de esta forma:
{"productos":[{"nombre":"marca, producto y presentación como se lee en el empaque","busqueda":"3 a 5 palabras clave para buscarlo en un catálogo, por ejemplo: coca cola 1.5 pet","unidades_visibles":4,"confianza":"alta|media|baja"}],"observaciones":"una frase sobre huecos, desorden o calidad de la foto"}
Si la imagen no es una estantería con productos, devuelve "productos": [] y explícalo en observaciones.`;

/** Reconoce los productos de una foto de estantería. Devuelve { productos, observaciones }. */
export async function leerEstanteria(mediaType, base64) {
  const client = cliente();
  const respuesta = await client.beta.messages.create({
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
