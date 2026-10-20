---
name: probar-sku
description: Corre una búsqueda real de un SKU de refrigerador contra todas las tiendas, sin tocar el histórico del usuario, y resume qué respondió cada tienda y las mejores ofertas. Úsala para verificar cambios en adaptadores, extractor o normalización contra los sitios reales.
argument-hint: <SKU> [id-tienda,...]
allowed-tools: Bash(node .claude/skills/probar-sku/smoke.mjs *)
---

Corre:

```bash
node .claude/skills/probar-sku/smoke.mjs $ARGUMENTS
```

- El primer argumento es el SKU (por ejemplo `RT38K5930S8`). El segundo, opcional, limita la prueba a tiendas separadas por coma (`liverpool,coppel`), usando los `id` de `server/adapters/stores.js`.
- Usa una carpeta de datos temporal: no escribe en `data/` del usuario. Tarda de 30 a 120 s.

Al terminar, reporta al usuario:

1. La tabla por tienda tal como sale (estado, ofertas exactas, nota, tiempo).
2. Las tiendas en `blocked`, `error` o `nomatch` y la causa probable: anti-bots, URL de búsqueda cambiada, parser que ya no encuentra tarjetas o modelo que la tienda no vende.
3. Si una tienda falló y el usuario quiere repararla, sigue la skill `agregar-tienda`.

No concluyas que una tienda "funciona" solo porque no dio error: confirma que tenga ofertas `exact` con precio razonable.
