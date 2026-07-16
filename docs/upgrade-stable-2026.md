# Actualizacion estable de Hubs - Julio 2026

## Objetivo

Integrar las ultimas releases estables oficiales sobre el baseline YenHubs ya recuperado y auditado, sin mezclar la
actualizacion con cambios visuales ni desplegar antes de repetir la aceptacion funcional.

## Fuente de verdad

| Capa | Baseline aceptado | Candidato de upgrade | Release oficial integrada |
| --- | --- | --- | --- |
| Superproyecto | `codex/audit-2026` (`94433c3`) | `codex/upgrade-stable-2026` (`0850ce1` + cierre) | N/A |
| Cliente Hubs | `codex/audit-2026` (`7f016c9869`) | `codex/upgrade-hubs-prod-2026-03-11` (`e22520dda`) | `prod-2026-03-11` (`e3b9cc749`) |
| Hubs CE | `codex/audit-2026` (`dfc248f6bd`) | `codex/upgrade-hcce-2.1.0` (`cc43df4`) | `2.1.0` (`410bc52`) |

El candidato final esta desplegado y aceptado. Tras el cierre documental, estas ramas se fusionan en `hubs/master`,
`hubs-cloud/master` y `meta-hubs/main`.

## Que se integro

### Hubs `prod-2026-03-11`

- Fix oficial para PDF bajo VR movil, que usa `xrSession.requestAnimationFrame` cuando corresponde.
- La release oficial queda como ancestro de la rama; no quedan commits de la release pendientes.
- No se incorporo `upstream/master`: contiene trabajo posterior a la release y se auditara por separado.

### Hubs CE `2.1.0`

- Version del generador actualizada de 2.0.0 a 2.1.0.
- `relay` SMTP de Swoosh anadido sin retirar `server`, necesario para el Reticulum custom que aun usa Bamboo/Mailtrap.
- `package-lock.json` alineado con 2.1.0.
- El cambio oficial de branding de imagenes no se aplica a valores reales: YenHubs fija todas las imagenes por digest.
- `community-edition/input-values.yaml` permanece ignorado y fuera de Git. El merge oficial intento reintroducirlo y
  se resolvio conservando la eliminacion; la copia real se restaura desde `deployment/input-values.local.yaml`.

## Validacion completada

### Hubs

- `npm ci`: correcto.
- `npm run check`: correcto.
- `npm test`: lint JS/HTML y 12 pruebas unitarias correctas.
- `npm run build`: correcto, con los warnings de tamano ya registrados en `AUD-015`.
- Storybook Actions `29433550837`: correcto.
- Imagen final Actions `29464896181`:
  `ghcr.io/yengalvez/hubs@sha256:c5e2ee4eb125535b8b8ca55a369f24e2e2c5bcf2882158e53996bf5df3c030f3`.
- El arbol no cambio al registrar la release como ancestro despues de probar el fix oficial.

### Hubs CE

- `npm ci`: correcto.
- `npm run gen-hcce`: 44 recursos, verificacion correcta.
- El generador produce 44 recursos y conserva `relay` y `server` SMTP, digests, ingress, PVC y hardening.
- CI Reticulum y la validacion de uploads pasan sobre PostgreSQL 12.19/14.23 y release `turkey`.

## Features personalizadas reaceptadas

1. Entrada a lobby y sala en desktop, tablet y movil; escena 3D visible y CSP sin 404 de bundles.
2. Primera/tercera persona en desktop; la prioridad VR queda verificada por codigo y pendiente de casco fisico.
3. Sit/stand basico, feedback sin asiento y perdida de ownership; carrera multiusuario dedicada pendiente.
4. Avatar normal, RPM full-body, Avaturn privado, previews y validacion server-side.
5. Ghost runner: aparicion, movimiento, featured, late join y config 5 -> 10 -> 5 sin reinicio.
6. Spoke: dos guardados reales y reconciliacion segura; Publish/Delete aislado queda pendiente.
7. Admin: importacion local, listing, featured y 0 advisories de produccion.
8. Dialog: audio real entre dos navegadores y Coturn/TCP.
9. Mailtrap: signin real desde `info@meta-hubs.org` conservando Bamboo `server`.
10. Verificador live, carga fria real y rollback Hubs probados.

## Riesgos y decisiones

- No desplegar Hubs sin reiniciar Reticulum y validar CSP/bundles y runtime en navegador real.
- No usar `npm audit fix --force`; el arbol de produccion ya esta en 0 y la deuda dev se gestiona por lotes.
- No mergear `upstream/master` hasta cerrar esta release estable.
- No versionar valores locales ni sustituir digests por tags de branding oficiales.
- No aprovechar esta rama para redisenar la UI. El pulido visual se hace despues de estabilizar la actualizacion.
- La prueba Publish/Delete de Spoke sigue pendiente y debe usar un proyecto duplicado sin referencias de salas.

## Resultado

La actualizacion estable esta completada. El rollback real detecto y contuvo una incompatibilidad de `js-cookie 3`;
la correccion usa parseo seguro y 12 pruebas. La aceptacion final incluye navegador frio, bots, responsive, assets/CSP,
DB/storage, hardening y manifiesto. Los limites restantes estan en `docs/audit-2026-07.md` y el estado operativo en
`docs/project-handoff-2026-07.md`.
