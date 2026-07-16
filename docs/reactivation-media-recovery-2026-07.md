# Recuperacion de contenido Reticulum - Julio 2026

Este documento registra el hallazgo que impide considerar completa la reactivacion funcional. No contiene secretos.

## Estado comprobado

- El cluster, los 12 deployments, DNS autoritativo y los cuatro certificados TLS estan operativos. Algunos
  resolvers publicos aun alternan temporalmente con la delegacion antigua por cache.
- La base `retdb` de marzo se restauro: 17 hubs, 1 escena, 12 avatares y 93 filas activas en `ret0.owned_files`.
- Las 93 filas representan 439,216,786 bytes historicos.
- El nuevo `ret-pvc` esta vacio (solo `lost+found`, unos 20 KiB).
- No existen snapshots de volumen en la cuenta de DigitalOcean y los dos volumenes antiguos se borraron en marzo.
- El backup de marzo no contiene `/storage/owned` ni archivos `.blob`/`.meta.json`.

La base guarda UUID, clave, tipo y relaciones. Los bytes reales estaban cifrados en `ret-pvc`; por eso restaurar solo
PostgreSQL devuelve URLs validas pero los archivos responden vacios/error.

## Alcance activo

De los 93 archivos historicos, 44 siguen referenciados por objetos activos y suman 148,718,557 bytes:

- 8 referencias de escena, proyecto y scene listing.
- 34 referencias de avatares/listings.
- 2 referencias del modelo fuente de la sala y su miniatura.

## Fuentes recuperadas localmente

Se localizaron y preservaron fuera de Git:

- `Escena_Principal_Ligthmap_New.glb` (39,343,012 bytes). Coincide exactamente en tamano con el asset fuente
  `PrfAfvo` registrado en la base y contiene `MOZ_hubs_components`.
- GLB originales de `base`, `Camiseta`, `Bata`, `Bata2`, `CamisaNegra`, `CamisaNegra2`, `CamisaVaqueros`,
  `CamisaVaqueros2` y `modelT`.
- Al separar esos GLB con el contrato del importador, todos los bloques BIN coinciden exactamente en tamano con las
  referencias activas de la base. El JSON glTF es regenerable, aunque difiere ligeramente por version del importador.

Bundle local ignorado por Git:

```text
/Users/Shared/Gits/YenHubs/output/reactivation-20260714-003330/recovery-sources/
```

Los hashes SHA-256 de los diez GLB del bundle se verificaron correctamente. No mover estos ficheros al historial de
Git: son artefactos binarios de recuperacion, no codigo fuente del fork.

## Contenido no localizado exactamente

- Modelo final publicado de la escena `Crater`: 41,032,236 bytes.
- Proyecto Spoke actual: 29,225 bytes (referenciado dos veces).
- Modelo de scene listing: 41,029,144 bytes y proyecto asociado de 23,701 bytes.
- Miniaturas originales. Se pueden regenerar, pero no recuperar byte a byte.

El modelo fuente permite reconstruir la sala, pero no contiene los `spawbot-*` que se anadieron posteriormente en
Spoke. No se debe sustituir silenciosamente el contenido historico por este modelo y afirmar que es una restauracion
exacta.

## Ruta segura de recuperacion

1. Mantener intacta la base restaurada y el `ret-pvc` vacio hasta elegir estrategia.
2. Cerrar cualquier sesion antigua de Spoke y volver a entrar por magic link. Tras restaurar la base, el navegador
   puede mostrar `Logout` pero recibir `401` en `/api/v1/projects`; no es un fallo CORS, sino una credencial anterior
   que ya no es valida.
3. Subir `Escena_Principal_Ligthmap_New.glb` por el flujo normal de Spoke/Reticulum y guardar la URL devuelta.
4. Generar el proyecto Spoke reproducible con esa URL:

   ```bash
   cd /Users/Shared/Gits/YenHubs
   node deployment/generate-recovery-spoke-project.js \
     --scene-url 'https://meta-hubs.org/files/<UUID-DEVUELTO>.glb' \
     --output-dir output/reactivation-20260714-003330/recovery-project-final
   ```

5. Importar `recovery-scene.spoke` en Spoke y recolocar visualmente el spawn, los ocho `spawbot-recovery-*` y los dos
   asientos. Verificar tambien las dos luces de recuperacion y reducirlas o eliminarlas si los lightmaps ya iluminan
   correctamente en runtime. Las posiciones e iluminacion generadas son deliberadamente provisionales porque el
   proyecto Spoke final se perdio.
6. Comprobar que el modelo conserva `collidable` y `walkable`, añadir un `Floor Plan` que cubra toda la superficie
   transitable, comprobar que la exportacion contiene `nav-mesh`, verificar que los bots conservan el prefijo
   `spawbot-*` y que los asientos tienen `Disable motion` y `Can be occupied`.
7. Publicar la escena y asignarla primero a un hub de prueba, no al hub historico.
8. Reimportar los GLB originales desde Admin y comprobar rig, thumbnails y tags featured.
9. Validar third-person, sitting y ghost bots en dos navegadores.
10. Solo despues, reasignar los hubs historicos y retirar listings rotos si el propietario lo aprueba.
11. Crear inmediatamente un dump nuevo y ejecutar `deployment/backup-ret-storage.sh`.

Sin `--scene-url`, el generador produce una plantilla con el marcador `__RECOVERED_SCENE_ASSET_URL__`. Esa variante
sirve para inspeccion local, pero no debe importarse en Spoke hasta sustituir el marcador por una URL real. El script
es determinista, valida 15 entidades e incluye manifiesto y hashes de sus salidas. No hace peticiones de red ni escribe
en DigitalOcean.

## Estado final de la recuperacion funcional

El 14 de julio de 2026 se completo una reconstruccion funcional, sin afirmar que sea una copia exacta del contenido
perdido:

- Upload fuente verificado: escena `fuWfRdF`.
- Proyecto editable de Spoke: `qa3U3Ke`, disponible en
  `https://meta-hubs.org/spoke/projects/qa3U3Ke`.
- Escena publicada: `f6VKtim`, `YenHubs Recuperacion Funcional`.
- Sala de prueba: `XesSAqd`, `https://meta-hubs.org/XesSAqd/prickly-nice-huddle`.
- La reconstruccion inicial contenia 15 entidades: root, modelo, dos luces, un spawn, ocho
  `spawbot-recovery-*` y dos waypoints de asiento con `Disable motion` y `Can be occupied`. El proyecto publicado
  actual anade ademas el `Floor Plan`.
- El ghost runner reconoce 11 waypoints, usa 8 para spawn/patrulla y crea los 3 bots configurados. No aparece como
  usuario en `Personas`.
- El 16 de julio se anadio un `Floor Plan` nativo y se republico la misma escena `f6VKtim`. El modelo publicado
  `749efd34-73a0-496c-8584-3958b01ef186.bin` contiene un nodo `navMesh` con componente `nav-mesh`. Marcar el modelo
  importado como `walkable`/`collidable` no sustituye este paso: sin nav mesh el controlador puede permitir movimiento
  vertical y atravesar el suelo.

Tambien se reconstruyeron miniaturas reales y se importaron nueve avatares mediante los endpoints normales de
Reticulum. `base` quedo como base/default (`5J1OZx-`) y los ocho modelos full-body quedaron featured:

| Nombre | Listing featured |
|--------|------------------|
| Bata | `84PKFaQ` |
| Bata2 | `y_GoczU` |
| CamisaNegra | `x0h-wd0` |
| CamisaNegra2 | `f8zTm-g` |
| CamisaVaqueros | `mKOnfC8` |
| CamisaVaqueros2 | `t_zomhE` |
| Camiseta | `3LVfOJj` |
| modelT | `FC4sbP3` |

Los nueve endpoints de avatar y `avatar.gltf` responden HTTP 200. Los dos listings historicos featured que apuntaban
a bytes perdidos (`vCCjKkl` y `omfp69L`) se conservaron, pero se les retiro solamente el tag `featured` para impedir
que los bots seleccionen assets rotos.

Smoke test final:

- sala y escena 3D visibles;
- tres bots con avatares recuperados y movimiento entre waypoints;
- `Personas (1)`, por lo que runner y bots no consumen identidades visibles;
- tercera persona activa y vuelve a primera persona;
- endpoint de chat privado del bot responde mediante el backend;
- base/default y ocho featured aparecen en las APIs de catalogo.

La perdida restante afecta a la copia exacta del antiguo proyecto/miniaturas y a otros medios historicos que no
estaban entre los diez GLB recuperados. No bloquea las funcionalidades personalizadas ni el inicio de la auditoria,
pero debe conservarse esta limitacion en cualquier informe futuro.
