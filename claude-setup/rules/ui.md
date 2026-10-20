---
paths:
  - "public/**"
---

# Interfaz

- Dirección visual "herramienta de precisión": papel cálido, tinta, acento bermellón **solo para acciones**, calcomanía amarilla para PROMO, números en IBM Plex Mono tabular y Schibsted Grotesk para texto (fuentes servidas desde `node_modules`, funciona sin conexión).
- Colores solo como tokens OKLCH en `:root`, con su par en `@media (prefers-color-scheme: dark)`. No usar colores sueltos.
- Evitar gradientes, glassmorphism, sombras decorativas y cards dentro de cards.
- Todo texto que viene de tiendas pasa por `esc()` y las URLs por `safeUrl()` antes de ir al DOM.
- Textos en español de México. Revisa cambios visuales con captura en escritorio y a 390 px, claro y oscuro.
