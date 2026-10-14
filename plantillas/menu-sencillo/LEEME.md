# Página sencilla de menú

Es la página que se le deja a un restaurante que no continúa con el servicio: muestra el menú con
precios y un botón que abre su WhatsApp. No toma pedidos, no tiene asistente ni panel, y no necesita
servidor ni base de datos, así que mantenerla publicada no cuesta nada.

## Qué se edita

Solo `menu.js`. Ahí están el nombre, el lema, el WhatsApp, la dirección, el horario, los colores de la
marca y las categorías con sus productos. `index.html` no se toca.

- **WhatsApp:** con indicativo y sin espacios. Para Colombia, `57` más el número.
- **Fotos y logo:** se copian a esta misma carpeta y se escribe el nombre del archivo (`"clasica.jpg"`).
  Sin foto, el plato sale solo con texto y se ve bien.
- **Colores:** `color` es el de la marca (encabezado y títulos) y `acento` el fondo de los precios.
- **Pie de página:** `hechoPor` y `hechoPorEnlace`. Vacíos, no aparece.

## Cómo se publica

1. Copiar esta carpeta a un repositorio propio del restaurante.
2. Crear un proyecto en Vercel apuntando a ese repositorio. No hay nada que compilar: es estático.
3. En Vercel, en Domains, agregar el dominio del restaurante.

Para verla en el computador basta con abrir `index.html` con doble clic.
