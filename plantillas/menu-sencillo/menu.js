// Todo lo que cambia de un restaurante a otro está aquí. La página (index.html) no se toca.
// Los datos de abajo son de ejemplo: reemplázalos por los del restaurante.
window.MENU = {
  nombre: "La Hamburguesería",
  lema: "Hamburguesas a la parrilla, hechas al momento",
  // Con indicativo del país y sin espacios ni signos. Colombia: 57 + el número.
  whatsapp: "573001234567",
  direccion: "Cra 00 # 00-00, Cali",
  horario: "Todos los días de 12 m. a 10 p.m.",
  domicilio: "Domicilio desde $4.000 según la zona",
  // Opcionales. Deja "" lo que no aplique.
  logo: "", // por ejemplo "logo.png", en esta misma carpeta
  instagram: "", // por ejemplo "https://www.instagram.com/usuario"
  // Color de la marca (botones y títulos) y color de acento (precios).
  color: "#b3261e",
  acento: "#f2a900",
  // Pie de página. Deja "" para no mostrarlo.
  hechoPor: "Pedidos automáticos por WhatsApp",
  hechoPorEnlace: "",

  categorias: [
    {
      nombre: "Hamburguesas",
      nota: "Todas van con papas a la francesa.",
      productos: [
        { nombre: "Clásica", detalle: "Carne de res 150 g, queso, lechuga, tomate y salsa de la casa.", precio: 18000, foto: "" },
        { nombre: "Doble queso", detalle: "Doble carne, doble queso cheddar, cebolla caramelizada.", precio: 25000, foto: "" },
        { nombre: "Tocineta BBQ", detalle: "Carne de res, tocineta crocante, queso y salsa BBQ.", precio: 23000, foto: "" },
        { nombre: "Pollo crispy", detalle: "Pechuga apanada, queso, lechuga y mayonesa de ajo.", precio: 20000, foto: "" },
      ],
    },
    {
      nombre: "Acompañantes",
      productos: [
        { nombre: "Papas a la francesa", detalle: "Porción grande.", precio: 7000, foto: "" },
        { nombre: "Aros de cebolla", detalle: "8 unidades con salsa.", precio: 8000, foto: "" },
        { nombre: "Adición de queso", detalle: "", precio: 3000, foto: "" },
      ],
    },
    {
      nombre: "Bebidas",
      productos: [
        { nombre: "Gaseosa 400 ml", detalle: "", precio: 4500, foto: "" },
        { nombre: "Limonada natural", detalle: "", precio: 6000, foto: "" },
        { nombre: "Cerveza nacional", detalle: "Solo para mayores de edad.", precio: 6000, foto: "" },
      ],
    },
  ],
};
