# Sauko Store · página, asistente de pedidos y panel

Página del minimarket Sauko Store (Hacienda Kachipay, Cali) con un asistente de IA que toma pedidos por chat y un panel para que la tienda confirme pagos, aliste y despache.

## Cómo correrlo

```bash
npm install
```

Copie `.env.example` a `.env` y llene al menos `ANTHROPIC_API_KEY`.

```bash
npm run dev
```

- Página: http://localhost:3000
- Panel de la tienda: http://localhost:3000/#panel (pide el `PANEL_PIN`; en local, sin PIN definido, queda abierto)

Sin `ANTHROPIC_API_KEY` la página y el panel funcionan, pero el chat avisa que el asistente no está disponible.

## Qué hay

| Ruta | Qué es |
| --- | --- |
| `public/index.html` | Toda la página: inicio, tienda por categorías, chat y panel. |
| `public/catalog.json` | Catálogo: código, nombre, precio, categoría y si tiene foto. Es la fuente de precios del servidor. |
| `public/fotos-*.json` | Fotos de producto por categoría (de Open Food Facts). |
| `lib/agente.js` | Instrucciones y voz del asistente, definición de sus herramientas y la llamada a Claude. |
| `lib/store.js` | Pedidos y agotados: Redis de Upstash si está conectado; si no, memoria (solo para local). |
| `lib/comun.js` | Catálogo en el servidor, PIN del panel y tope de mensajes del chat. |
| `api/chat.js` | Un paso del asistente. La página ejecuta las herramientas y vuelve con los resultados. |
| `api/orders.js` | Pedidos. Recalcula nombres, precios y total con el catálogo antes de guardar. |
| `api/agotados.js` | Productos marcados como agotados desde el panel. |
| `api/estanteria.js` | Control de estantería: reconoce productos en una foto. |
| `api/whatsapp.js` | Webhook de WhatsApp Cloud API (Meta): recibe texto y fotos, valida la firma y responde. |
| `lib/conversacion.js` | El asistente por WhatsApp: ejecuta las herramientas en el servidor y guarda la conversación de cada teléfono. |
| `lib/tienda.js`, `lib/whatsapp.js` | Búsqueda en el catálogo y pedido en el servidor; envío de mensajes y descarga de fotos de Meta. |
| `server.js` | Servidor local. En Vercel no se usa. |

## Desplegar en Vercel

1. Importar este repositorio en Vercel (sin framework; no necesita build).
2. En Storage, crear una base **Upstash for Redis** y conectarla al proyecto. Vercel agrega `KV_REST_API_URL` y `KV_REST_API_TOKEN`. Sin esta base los pedidos no llegan al panel.
3. En Settings → Environment Variables, agregar `ANTHROPIC_API_KEY` y `PANEL_PIN`.
4. Desplegar y conectar el dominio.

## Conectar WhatsApp por YCloud

Es el camino elegido: el número de la tienda sigue funcionando en su app WhatsApp Business.

1. Crear la cuenta en ycloud.com y conectar el número con la opción de WhatsApp Business App (coexistencia).
2. En Developers → API Keys, crear la clave. En Developers → Webhook, agregar `https://<dominio>/api/ycloud` con el evento `whatsapp.inbound_message.received` y copiar el secreto.
3. En Vercel, agregar `YCLOUD_API_KEY`, `YCLOUD_FROM` (el número con +57) y `YCLOUD_WEBHOOK_SECRET`, y volver a desplegar.

Pendiente: cuando el dueño responde a mano desde el celular, el asistente no se entera y puede contestar también.

## Conectar WhatsApp directo con Meta (alternativa)

1. En developers.facebook.com, crear una app de tipo Business y agregar el producto WhatsApp. Meta da un número de prueba que puede escribirle a los teléfonos que se registren ahí.
2. En Vercel, agregar `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (App Secret de la app) y `WHATSAPP_VERIFY_TOKEN` (una palabra inventada), y volver a desplegar.
3. En la app de Meta, WhatsApp → Configuration → Webhook: URL `https://<dominio>/api/whatsapp`, el mismo verify token, y suscribir el campo `messages`.
4. Escribirle al número de prueba desde un teléfono registrado.

El token temporal de Meta vence en 24 horas; para dejarlo fijo se crea un usuario del sistema en Meta Business y se genera un token permanente. Sin la base Redis las conversaciones de WhatsApp se pierden entre mensajes.

## Lo que falta para operar de verdad

- **Inventario real.** Las existencias son simuladas en el navegador. Falta conectar Siigo.
- **WhatsApp.** El canal está construido pero sin probar con Meta: falta la app, el número real y la verificación del negocio. Por WhatsApp no hay existencias: solo se excluye lo marcado como agotado en el panel.
- **Pago.** El asistente lee el comprobante y la tienda lo confirma a mano. No hay verificación contra Nequi ni el banco.
- **Costo de domicilio y cobertura.** Los $2.000 por debajo de $20.000 son un valor de ejemplo.
- **Categorías.** Los productos que estaban en "Otros" se clasificaron automáticamente por nombre; conviene revisarlos.
- **Fotos.** Cinco fotos de categoría son de referencia (Unsplash) y solo 598 productos tienen foto.
- **Tope de gasto.** El límite de mensajes del chat es aproximado; el tope duro se configura en la consola de Anthropic.
