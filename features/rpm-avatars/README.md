# Compatibilidad con avatares RPM y rigs Mixamo

## Estado

Ready Player Me discontinuó sus servicios el 31 de enero de 2026 y su portada
actual confirma el cierre. YenHubs no debe depender de su iframe, API, CDN ni
creación de cuentas.
Los GLB exportados con anterioridad siguen siendo ficheros del usuario y se
pueden cargar mediante el flujo neutral **Subir GLB (privado)**.

La compatibilidad ya presente en el cliente Hubs se conserva, pero los cambios
de interfaz neutral están todavía en fuente candidata: no deben describirse
como desplegados hasta completar Actions, digest, rollout y aceptación cold
browser.

Fuentes y decisión vigente:

- [portada que confirma la discontinuación](https://readyplayer.me/?welcome=true)
  y [anuncio previo del cierre](https://forum.readyplayer.me/t/an-important-update-from-ready-player-me/3706);
- [evaluación de proveedores de julio de 2026](../../docs/avatar-provider-evaluation-2026-07.md);
- [contrato de carga privada de GLB](../avaturn/README.md).

## Contrato que YenHubs mantiene

- La frontera de integración es un GLB 2.0, no una API de proveedor.
- La carga manual existente sigue disponible para RPM ya exportados, MPFB,
  MakeHuman, MetaPerson, Avaturn u otra herramienta compatible.
- El fichero se valida, se previsualiza y se guarda como avatar privado/no
  listado; no se publica automáticamente en los listados de la instancia.
- El esqueleto upper-body requerido por Hubs debe estar presente.
- La detección full-body/Mixamo conserva locomoción y representación de cuerpo
  completo cuando el rig es compatible.
- No se almacenan fotos originales, tokens de proveedor ni credenciales de un
  editor externo.
- “Privado” significa no listado. El GLB sigue sujeto a administradores,
  permisos, almacenamiento y backups de YenHubs; no es cifrado extremo a
  extremo.

Los aliases internos históricos pueden mantenerse mientras haya datos o
automatizaciones que los consuman, pero la UI y los mensajes de error deben ser
neutrales respecto del proveedor.

## Pruebas obligatorias

Antes de aceptar un cambio de avatar o de animación:

1. cargar un GLB upper-body y otro full-body/Mixamo válidos;
2. rechazar un fichero corrupto, demasiado grande o sin esqueleto compatible;
3. comprobar preview, thumbnail, guardado no listado y `Mis avatares`;
4. validar primera y tercera persona, idle, walk, run, sitting y standing;
5. comprobar sincronización remota, manos, escala, orientación y suelo;
6. repetir el cold load en escritorio y móvil sin errores ni warnings;
7. confirmar que un rollback del cliente no modifica avatares ya guardados.

Una prueba que guarde datos necesita antes un checkpoint conjunto de PostgreSQL
y `ret-pvc`.

## Investigación histórica

Los documentos, FBX, prototipos y utilidades de la investigación original se
conservan en `OLD/features/rpm-avatar-research/`. Son evidencia opcional, no
instrucciones de implementación ni fuente de despliegue. El contrato activo es
este README y el código/pruebas integrados en `hubs/`.

No debe reintroducirse Ready Player Me ni otro proveedor embebido sin superar
las puertas de licencia, privacidad, coste, seguridad y salida descritas en la
evaluación vigente.
