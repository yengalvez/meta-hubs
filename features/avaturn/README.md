# Avatares Avaturn privados

## Estado

La feature esta implementada en el cliente Hubs. Un usuario autenticado puede
subir un `.glb` desde el selector de avatares y conservarlo como avatar de su
cuenta sin publicarlo en los listados.

## Contrato

- Formato: GLB 2.0.
- El cliente valida que exista un skeleton upper-body compatible.
- Se genera preview/thumbnail antes de habilitar Guardar.
- `allow_promotion=false`.
- `allow_remixing=false`.
- El flujo no crea un `avatar_listing`.
- El avatar aparece en `Mis avatares` de su propietario.

La privacidad aqui significa **no listado**. El archivo sigue almacenado en la
instancia Hubs y sujeto a sus permisos y backups.

## Uso

1. Iniciar sesion.
2. Abrir Cambiar avatar.
3. Seleccionar `Subir Avaturn (privado)`.
4. Elegir el `.glb`.
5. Esperar preview y validacion.
6. Guardar.
7. Seleccionarlo en `Mis avatares`.

La ayuda integrada explica la exportacion desde Avaturn.

## Implementacion

Archivos principales:

- `hubs/src/react-components/media-browser.js`;
- `hubs/src/react-components/avatar-editor.js`;
- `hubs/src/react-components/room/AvaturnHelpModal.js`;
- `hubs/src/utils/avatar-glb-utils.js`;
- `hubs/src/utils/avatar-skeleton-utils.js`;
- validacion server-side en Reticulum.

## Pruebas de regresion

- GLB valido con skeleton compatible.
- GLB corrupto, demasiado grande o sin skeleton.
- Preview antes de Guardar.
- Aparicion en `Mis avatares`.
- Ausencia en Featured y listings publicos.
- Otro usuario no lo recibe en `Mis avatares`.

El guardado real muta DB y storage: crear checkpoint antes de una prueba de
produccion.

## Investigacion historica

La investigacion inicial, ejemplos de iframe y documentos extensos previos a la
implementacion estan archivados en `OLD/features/avaturn-research/`. No forman
parte del flujo vigente.
