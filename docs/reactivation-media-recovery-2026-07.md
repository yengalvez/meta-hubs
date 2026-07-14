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
2. Crear en Spoke una escena nueva desde `Escena_Principal_Ligthmap_New.glb`.
3. Reponer waypoints `spawbot-*`, spawn points y asientos `Disable motion` en una sala de prueba.
4. Publicar la escena y asignarla primero a un hub de prueba, no al hub historico.
5. Reimportar los GLB originales desde Admin y comprobar rig, thumbnails y tags featured.
6. Validar third-person, sitting y ghost bots en dos navegadores.
7. Solo despues, reasignar los hubs historicos y retirar listings rotos si el propietario lo aprueba.
8. Crear inmediatamente un dump nuevo y ejecutar `deployment/backup-ret-storage.sh`.

No se ha escrito contenido reconstruido en produccion durante este analisis.
