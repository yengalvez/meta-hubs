# Actualizacion estable de Hubs - Julio 2026

## Objetivo

Integrar las ultimas releases estables oficiales sobre el baseline YenHubs ya recuperado y auditado, sin mezclar la
actualizacion con cambios visuales ni desplegar antes de repetir la aceptacion funcional.

## Fuente de verdad

| Capa | Baseline aceptado | Candidato de upgrade | Release oficial integrada |
| --- | --- | --- | --- |
| Superproyecto | `codex/audit-2026` (`94433c3`) | `codex/upgrade-stable-2026` | N/A |
| Cliente Hubs | `codex/audit-2026` (`7f016c9869`) | `codex/upgrade-hubs-prod-2026-03-11` | `prod-2026-03-11` (`e3b9cc749`) |
| Hubs CE | `codex/audit-2026` (`dfc248f6bd`) | `codex/upgrade-hcce-2.1.0` | `2.1.0` (`410bc52`) |

Produccion sigue usando el baseline auditado. Estas ramas no se consideran desplegables hasta completar los gates de
aceptacion de este documento.

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
- `npm test`: lint JS/HTML y 4 pruebas unitarias correctas.
- `npm run build`: correcto, con los warnings de tamano ya registrados en `AUD-015`.
- Storybook Actions `29433550837`: correcto.
- Imagen candidata Actions `29434015549`: `ghcr.io/yengalvez/hubs@sha256:fa72e5ea526704337ed0eef182b0005899d559cae775a2c9761c13577d909786`.
- El arbol no cambio al registrar la release como ancestro despues de probar el fix oficial.

### Hubs CE

- `npm ci`: correcto.
- `npm run gen-hcce`: 44 recursos, verificacion correcta.
- El diff contra produccion es solo el `ConfigMap ret-config`: anade `relay` y conserva `server`; no cambia imagenes,
  Secrets, ingress, PVC ni workloads.
- CI Reticulum `29433706318`: PostgreSQL 12.19/14.23 y release `turkey` correctos. El codigo Reticulum es identico al
  baseline `dfc248f6bd` ya aceptado.

## Features personalizadas que deben reaceptarse antes de desplegar

1. Entrada a lobby y sala en desktop y movil; escena 3D visible y CSP sin 404 de bundles.
2. Primera/tercera persona y prioridad de primera persona en VR.
3. Sit/stand, waypoint `Disable motion` y perdida de ownership entre dos usuarios.
4. Avatar normal, RPM full-body, Avaturn privado y previews.
5. Ghost runner: aparicion, movimiento, featured avatar, chat privado, historial por sesion y navegacion allowlist.
6. Spoke: abrir/guardar un duplicado aislado; no publicar `qa3U3Ke`, porque alimenta salas reales.
7. Admin: importacion local, listing y featured.
8. Dialog: audio real entre dos navegadores; Coturn/TCP cuando UDP no este disponible.
9. Mailtrap: signin real desde `info@meta-hubs.org` conservando Bamboo `server`.
10. Verificador live con 0 fallos/avisos y `kubectl diff` cero despues de cualquier rollout.

## Riesgos y decisiones

- No desplegar la rama Hubs por separado si su CSP/bundles no se validan contra Reticulum.
- No usar `npm audit fix --force`; Hubs conserva deuda de dependencias que requiere lotes separados.
- No mergear `upstream/master` hasta cerrar esta release estable.
- No versionar valores locales ni sustituir digests por tags de branding oficiales.
- No aprovechar esta rama para redisenar la UI. El pulido visual se hace despues de estabilizar la actualizacion.
- La prueba Publish/Delete de Spoke sigue pendiente y debe usar un proyecto duplicado sin referencias de salas.

## Siguiente gate

Desplegar el digest candidato ya construido primero en un entorno/canary aislado y ejecutar la checklist anterior. Solo
tras esa aceptacion se propone un diff de produccion y se solicita autorizacion de rollout.
