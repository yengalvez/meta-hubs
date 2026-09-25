# Avatares: candidato de publicación

## Resultado solicitado y alcance
Publicar 33 avatares catalogados y las mejoras locales aceptadas de Avaturn,
selector y animación, dejando una versión en DigitalOcean para pruebas reales.
El nombre comercial es Avatares. Se preserva la procedencia técnica y los GLB
originales, los siete IDs publicados y el avatar Avaturn existente. No incluye
el cambio pendiente de proveedor/modelo de IA ni nuevos recursos o costes.
La documentación del producto cerrado se hará después de las pruebas del dueño.

## Fuentes y estado
- Cliente Hubs: b805d96d30b4b6e5230a4ec9ae134896360b858e.
- Build oficial 36164500021, SUCCESS, yengalvez/hubs, avatars-20260925.
- Imagen: ghcr.io/yengalvez/hubs@sha256:503ad3ad3931f77cdbaf708954fa40f70602eb71efe3ecd5447c16dd14c6c5b2.
- Cloud bb21cf34a0fa7080964be8d630550c4f76fe7871: runtime sin cambios respecto
  a 4a0885a; incluye únicamente reparación del verificador y coordinador de
  recuperación. Cloud6efe87a del checkout de diseño queda excluido.
- Cliente:199tests y build de producción pasan; revisión independiente de los
  ajustes de escala/retarget pasa. No retocar las posturas aceptadas por el dueño.
- Manifest nuevo:68recursos válidos; comparación real client-image-only-check
  pasa sin Lease ni mutaciones. Solo cambia OVERRIDE_HUBS_IMAGE. Esta comparación
  no concede la excepción visual ni sustituye el checkpoint de contenido.

La recuperación de la pausa anterior ya terminó:12/12Deployments listos,
verificador live0fallos/0avisos y navegador frío muestra escena y bots.
No confundir ese resultado con publicación: catálogo y cliente nuevos siguen
pendientes hasta su readback y aceptación en web.

## Pendiente de ejecución
- Copia conjunta con el monitor y la reanudación corregidos, desde la fuente
  limpia rpm-checkpoint-source-20260925. Ensayo positivo antes de otra pausa.
- Publicación representativa Bata/Camiseta2, resto, verificación paginada de
  nombres, IDs, binarios originales, miniaturas y listings ajenos conservados.
- Gate completo del candidato; aplicar exclusivamente el manifiesto generado,
  reiniciar Reticulum con la misma imagen para actualizar HTML y verificar live.
- Navegador frío, selección de avatar, sala, bots y flujo Avaturn. Registrar
  límites reales, no prometer prueba de voz, segundo usuario o aprobación visual
  que no se haya realizado.

Registro operativo de esta tarea y journal de contenido: checkout
YenHubs-avaturn, DOC/rpm-catalog-2026-09-25.md y directorio privado
rpm-catalog-20260925. Las credenciales y manifests no se copian al repositorio.
