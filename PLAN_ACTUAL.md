# PLAN ACTUAL — Sitting v2 autoritativo

Version: **v6 — STAGING LEGACY VERDE; DNS Y HUBS V2 EN CURSO**
Ultima revision: **29 de agosto de 2026 (Europe/Madrid)**
Autoridad: **este fichero es la única cola ejecutable**. El plan de transición
cerrado se conserva en
`OLD/docs/PLAN_ACTUAL-feature-transition-2026-08-28.md`; la versión previa al
inventario externo se conserva en
`OLD/docs/PLAN_ACTUAL-sitting-v2-pre-inventory-2026-08-29.md`.

## Resultado buscado

Entregar Sitting v2 para que dos personas que pulsan **Sit** sobre la misma
silla nunca puedan quedar sentadas simultáneamente: Reticulum concede un único
lease autoritativo, el ganador se mueve y replica su pose, el perdedor permanece
de pie, y Stand, handoff y desconexión liberan la silla de forma observable.

La feature termina únicamente cuando:

1. la fuente exacta de Hubs y Reticulum pasa las pruebas locales aplicables;
2. las imágenes de esos mismos commits se construyen por GitHub Actions y se
   fijan por digest;
3. staging demuestra la carrera con dos navegadores, pose remota, Stand,
   relevo y cierre abrupto sin errores;
4. producción recibe los mismos digests en orden Reticulum primero y Hubs
   después, con checkpoint, rollback preparado, navegador frío y verificador
   live con cero fallos y cero avisos.

Un test unitario, un build o la existencia del código no sustituyen la carrera
real. La feature tampoco obliga a promover el runtime durable de bots.

## Decisión y estado confirmado

- El propietario eligió **Sitting v2** el 28 de agosto de 2026.
- Workspace raíz: `/Users/Shared/Gits/YenHubs-features`, rama local
  `codex/sitting-v2`, sobre el commit de transición `8c0d547`.
- Hubs: rama `codex/sitting-v2` en
  `b2697e7e6f571d195346cc156f0f1631eedc841a`. Es el corte funcional
  `ce8390a` más la corrección mínima de orden del Dockerfile demostrada por el
  primer build remoto.
- Cloud: rama local `codex/sitting-v2` en `acce87e`, que conserva la imagen
  Reticulum de `6d9ee9e` y añade la autenticación kubelet y el perfil staging
  legacy activo fail-closed. Las imágenes de producto aceptadas no cambiaron.
- Los commits Hubs `9c2da562b` y `3f18bdf24`, Cloud `ce20e20` y el arnés raíz
  `875642e` son ancestros de esos cortes. La implementación, migraciones y E2E
  ya existen; no se reescriben sin un fallo causal nuevo.
- El runtime productivo recuperado conserva Hubs `a7214eb88` y Reticulum/Cloud
  `5a82de5`, ambos anteriores a Sitting v2. La aceptación H5 demostró sitting
  histórico, no el protocolo v2 ni su carrera multiusuario.
- Sitting v2 necesita únicamente una imagen Hubs y una imagen Reticulum del
  corte actual. El primer staging demostró que el manifiesto durable actual no
  puede reutilizar directamente las imágenes bot legacy: el parent procede de
  `5a82de5` y exige `BOT_ACCESS_KEY`, mientras el manifiesto durable entrega
  `BOT_ORCHESTRATOR_ACCESS_KEY`; el runner fijado es todavía anterior. No se
  convierten por ello parent/runner en artefactos de esta release. Se completa
  la ruta trackeada de compatibilidad legacy para conservar bots sin mezclar
  otra modernización con Sitting.
- El inventario externo read-only del 29 de agosto confirmó los mismos commits
  en los `master` remotos, workflows activos, una sola instalación DOKS
  productiva y ausencia total de staging. La ruta elegida es un clúster DOKS
  temporal separado; no se comparte el clúster productivo.

## Requisitos de producto

1. Una silla válida tiene identidad Spoke estable y los flags `Disable motion`,
   `Can be occupied` y `Can be clicked`.
2. Reticulum/PostgreSQL es la única autoridad de exclusión; NAF es una
   proyección visual y nunca concede ocupación.
3. Dos reservas simultáneas producen exactamente un ganador y un perdedor.
4. El cliente solo se mueve después del `ok` autoritativo correlacionado.
5. El estado público no expone identidad, UUID de lease ni datos privados.
6. `player-info.isSitting` y la posición del avatar muestran al ganador sentado
   de forma coherente en ambos clientes.
7. Stand libera, apaga la pose y elige un waypoint no ocupable.
8. Tras liberar, el perdedor puede reclamar la misma silla.
9. Cierre limpio libera inmediatamente; el lease de 15 segundos protege la
   desconexión no observable.
10. Hubs v2 ante servidor antiguo o capacidad inválida falla cerrado. Un cliente
    antiguo puede convivir con Reticulum v2, pero esa ventana no acepta sillas.
11. No hay warnings/errores first-party, excepciones, requests fallidas ni HTTP
    `>= 400` durante la aceptación.

## Alcance, no objetivos y autoridad

Incluido:

- contrato y tests Sitting existentes en Hubs, Reticulum y browser;
- corrección local de un defecto solo si un verificador aplicable lo demuestra;
- build trazable de Hubs y Reticulum, staging y promoción productiva posterior;
- documentación, rollback y aceptación cold desktop/mobile.

Fuera de alcance:

- GLB neutral, personalidad de bots, runtime durable de bots o capacidad CCU;
- actualización upstream, modernización de Spoke o cambio de topología general;
- rediseñar recovery, repetir H5 o limpiar worktrees históricos;
- editar la escena principal para crear fixtures de prueba;
- revertir destructivamente la migración con leases activos.

Autorizado y completado: trabajo local reversible, inventario externo, builds
Hubs/Reticulum y la ventana S4 completa de staging, DNS, contenido desechable y
desmontaje con readback. Producción continúa fuera de alcance hasta S5.

## Plan de producción

### S0. Cerrar la transición y fijar ramas

- [x] Elegir Sitting v2 y descartar GLB neutral de esta cola.
  - Estado: **DONE**.
  - Evidencia: elección `1` del propietario.
- [x] Abrir ramas `codex/sitting-v2` en root, Hubs y Cloud desde los cortes
  exactos aceptados.
  - Estado: **DONE**.
  - Evidencia: las ramas quedaron fijadas inicialmente en Hubs `ce8390a` y
    Cloud `6d9ee9e`; S4 avanzó Hubs a `b2697e7` por un defecto exclusivo del
    Dockerfile de release.

### S1. Confirmar el gap real

- [x] Contrastar source, historial y runtime aceptado.
  - Estado: **DONE**.
  - Evidencia: el código y los tests v2 son ancestros del source actual; las
    imágenes live proceden de commits anteriores.
- [x] Limitar la release a Hubs + Reticulum.
  - Estado: **DONE**.
  - Consecuencia: no se construyen ni despliegan imágenes no relacionadas.

### S2. Refrescar evidencia local sobre los bytes exactos

- [x] Ejecutar la unidad contractual y enumeración Playwright de Sitting sin
  contactar una URL remota.
  - Estado: **DONE**.
  - Verificación: `npm ci`, `npm run test:unit` y
    `npm run test:sitting -- --list` en `tests/browser`.
  - Evidencia: unidad browser **11/11** y exactamente un E2E Sitting enumerado;
    no se abrió ni contactó una URL remota.
- [x] Ejecutar Hubs focal: TypeScript, lint de la superficie afectada y las
  pruebas AVA de reserva, identidad, intentos y diagnóstico de waypoints.
  - Estado: **DONE**.
  - Evidencia: TypeScript y lint dirigido correctos; AVA Sitting **48/48**
    sobre `ce8390a`. El aviso de datos Browserslist antiguos no es first-party
    ni alteró el resultado. No se atribuye un build todavía.
- [x] Ejecutar Reticulum focal: dependencias locked, format/compile estricto y
  las dos suites de reserva/modelo y canal contra PostgreSQL local.
  - Estado: **DONE**.
  - Evidencia: dependencias locked, format y compilación estricta correctos;
    las dos suites pasan **20/20** contra PostgreSQL local sobre `6d9ee9e`.
    Los warnings emitidos al compilar dependencias legacy no pertenecen al
    código first-party y la compilación estricta terminó con código cero.
- [x] Ejecutar composición/diff-check y registrar la evidencia exacta.
  - Estado: **DONE**.
  - Evidencia: **2/2** gitlinks verificados, `git diff --check` correcto en
    root/Hubs/Cloud, los tres árboles limpios y ningún proceso de prueba
    residual.
  - Nota: no se repite `--full`; no cambiaron bytes de producto y el gate final
    sectioned solo será necesario si una corrección invalida su cierre.

### S3. Resolver solo defectos demostrados

- [x] Si todos los focos pasan, declarar que no hace falta implementación nueva
  de producto y congelar los dos commits fuente.
  - Estado: **DONE**.
  - Evidencia final: Hubs `b2697e7e6f571d195346cc156f0f1631eedc841a` y Cloud
    `6d9ee9e998f636fcf61a4928cd2a275829768259` quedan congelados como fuentes
    candidatas; no se modificó código de producto. El hook de Hubs pasó
    **100/100** al corregir únicamente el orden de copia del script postinstall.
- [ ] Si falla un foco, corregir únicamente su causa en el subrepo dueño,
  repetir el verificador más cercano y actualizar el gitlink raíz.
  - Estado: **SKIPPED — ningún foco demostró un defecto**.
  - Regla: dos fallos equivalentes sin nueva evidencia producen STOP y
    replanteamiento, no otro intento ciego.

### S4. Construir y aceptar en staging

- [x] Auditar localmente la ruta de build y la disponibilidad de staging sin
  contactar servicios externos.
  - Estado: **DONE**.
  - Evidencia de build: los cortes contienen los workflows aprobados
    `hubs/.github/workflows/custom-docker-build-push.yml` y
    `hubs-cloud/.github/workflows/custom-docker-build-push.yml`. El primero
    construye Hubs con `RetPageOriginDockerfile`; el segundo debe recibir
    exactamente `Override_Repo_Name=reticulum`,
    `Override_Code_Path=community-edition/services/reticulum` y
    `Override_Dockerfile=community-edition/services/reticulum/Dockerfile`.
  - Evidencia de procedencia: los remote-tracking refs locales
    `origin/master` apuntan a `ce8390a` y `6d9ee9e`; se volverán a contrastar
    con GitHub antes de cualquier dispatch, porque esta comprobación no contactó
    el remoto.
  - Evidencia de target: no existe un contexto, dominio, values file ni sala
    staging trackeados. La plantilla permite cambiar `Namespace` y
    `HUB_DOMAIN`, pero eso no prueba aislamiento, capacidad, DNS, TLS, storage
    ni credenciales. El único target documentado es la instalación productiva
    y no se reutiliza como fixture.
- [x] Inventariar GitHub, DigitalOcean, Kubernetes y DNS público en read-only y
  elegir un único target.
  - Estado: **DONE**.
  - GitHub: `master` remoto sigue exactamente en Hubs `ce8390a` y Cloud
    `6d9ee9e`, ambos commits verificados; los dos workflows están activos, no
    existe build Sitting v2 y los repos públicos usan runners estándar sin
    coste de minutos.
  - DigitalOcean: una sola instalación productiva `hubs-ce` en `ams3`, DOKS
    `1.34.10-do.1`, HA desactivada, un nodo `s-4vcpu-8gb`, un `lb-small` y dos
    volúmenes de `10 GiB`. El preview de agosto es USD `64.85` por dos mitades
    de topología tras la recreación; el coste estable actual equivale a unos
    USD `65.03/mes`.
  - Kubernetes: ningún namespace/host staging; `12/12` Deployments productivos.
    El nodo tiene `3890m` CPU y unos `6414 MiB` asignables; los requests activos
    consumen `1297m/4002 MiB`. Quedan unos `2412 MiB`, menos que los `3200 MiB`
    de otra HCCE. Además, el manifiesto exige el namespace global fijo
    `hcce-bot-runners`, que colisionaría dentro del mismo clúster.
  - DNS: `staging.meta-hubs.org` y sus hosts `assets`, `stream` y `cors` no
    resuelven; los cuatro hosts productivos sí.
- [x] Seleccionar un staging aislado y acotar coste/TTL.
  - Estado: **DONE — propuesta revisada independientemente**.
  - Target: clúster temporal separado `yenhubs-sitting-staging`, región `ams3`,
    DOKS `1.34.10-do.2` —único parche `1.34.10` hoy disponible para alta—, HA
    desactivada, un nodo `s-4vcpu-8gb`, un `lb-small`, dos volúmenes de
    `10 GiB`, Namespace `hcce` y dominio `staging.meta-hubs.org`.
  - Coste observado: nodo USD `0.07143/h`, LB USD `0.02233/h` y volúmenes USD
    `0.00300/h`; total USD `0.09677/h`, unos USD `0.77/8 h`, `1.16/12 h` o
    `2.32/24 h`. Cost gate: máximo USD `2.35`, desmontaje iniciado antes de
    `23 h 30 min` desde el primer recurso facturable.
  - Decisión: añadir nodo/LB/PVC al clúster productivo cuesta prácticamente lo
    mismo, conserva colisiones globales y aumenta el radio de daño; compartir
    ingress ahorraría solo unos USD `0.54/24 h`. K3s/local no prueba el rollout
    DOKS/TLS. El control plane DOKS no-HA separado no añade coste.
- [x] Autorizar en una sola ventana la creación, uso y desmontaje exactos de S4.
  - Estado: **DONE — autorizado el 29 de agosto de 2026**.
  - Autoridad necesaria: dos Actions, acceso a credenciales staging, cuatro
    registros DNS staging, clúster/Namespace/LB/PVC, contenido Spoke
    desechable y eliminación con readback. Producción queda fuera de alcance.
- [x] Construir Hubs y Reticulum por los workflows aprobados y resolver ambos
  artefactos a digests con procedencia del commit exacto.
  - Estado: **DONE**.
  - Reticulum: run `33244980400`, intento 1, commit `6d9ee9e`, digest
    `ghcr.io/yengalvez/reticulum@sha256:256c292d0d5a69e021322bdbd11b3f318f2d44bee580433252e0b04ade1d5e18`.
  - Hubs: el run `33244979643` falló porque `npm ci` ejecutaba el postinstall
    antes de copiar `scripts/patch-draft-js-immutable-4.js`. Se corrigió solo
    ese orden en `b2697e7`; el run `33245207737`, intento 1 sobre esos bytes,
    quedó verde y publicó
    `ghcr.io/yengalvez/hubs@sha256:e8f9423ace1bf4108ae5a7ce59c1b45cf0b44b74ea944fdb82fee47e4d7be5b0`.
  - Reticulum no se repitió y no se creó DigitalOcean durante los builds.
- [x] Completar el preflight de staging antes del primer recurso facturable.
  - Estado: **DONE**.
  - Debe probar sin mostrar secretos: autoridad IONOS para los cuatro hosts,
    administrador/SMTP, values `0600` con claves staging independientes,
    acceso pull GHCR y ambos digests. Si algo falta, STOP sin crear DOKS.
  - Evidencia: DOKS `1.34.10-do.2` continúa disponible; NS/SOA confirman IONOS
    y los cuatro hosts siguen libres bajo la autoridad ya concedida; se
    heredaron solo admin/SMTP desde la fuente privada operativa y se generaron
    claves internas staging independientes. Los dos values son `0600`, cambian
    únicamente Hubs entre generaciones, el pull real de ambos digests GHCR
    pasó y los dos manifiestos privados verifican **68 recursos**.
  - DOKS creará además sus dos firewalls gestionados gratuitos; forman parte
    intrínseca del clúster y se incluyen en el readback final.
- [x] Crear el target exacto inicial, DNS/TLS y una sala staging desechable sin
  tocar la escena principal.
  - Estado: **DONE para la primera ejecución; su evidencia se conserva y sus
    recursos fueron desmontados con readback cero**.
  - Evidencia: el clúster inicial `17057b94-a707-46ab-8994-7ae31158b998`, nodo,
    LB `165.245.201.90`, dos PVC/volúmenes y dos firewalls ya no existen. Sus
    cuatro A records permanecen temporalmente para ser actualizados al nuevo
    LB. La sala `hg3jQAx` probó el join legacy antes del desmontaje; desapareció
    con la DB desechable y deberá crearse otra sala staging.
  - Nota: al ser greenfield y desechable no contiene datos de cliente y no
    requiere checkpoint; S5 sí exige checkpoint real antes de producción.
- [ ] Desplegar staging en dos generaciones: Reticulum/migración conservando
  Hubs anterior, verificar compatibilidad legacy, y después Hubs v2.
  - Estado: **IN PROGRESS — DNS/TLS y join legacy verdes; falta publicar el
    contenido Sitting en Spoke, promover Hubs v2 y ejecutar el E2E**.
  - Evidencia: Reticulum v2 convivió con Hubs legacy y Hubs candidato quedó
    fijado por digest. La transición durable `bootstrap -> admission -> active`
    validó sus guardas, pero el Deployment `bot-orchestrator` entró en
    `CrashLoopBackOff` y provocó `deployments_ready_timeout`; el apply valló los
    cinco consumidores y liberó la Lease. La procedencia GHCR y Git demuestra
    la causa: parent `325c5c...` fue construido desde `5a82de5` y exige
    `BOT_ACCESS_KEY`, mientras el manifiesto `6d9ee9e` entrega el contrato
    durable `BOT_ORCHESTRATOR_ACCESS_KEY`; runner `27324a...` es de marzo y
    tampoco implementa el protocolo aislado. La sala staging no tiene bots
    habilitados, por lo que no fue una creación de runner ni un fallo Sitting.
  - Corrección aplicada: `cold-rebind-legacy-active-v1` conserva el contrato
    process-local y omite RBAC/namespace/admisión durable. El driver fija antes
    de activar el target normalizado, admite el TypeMeta legalmente omitido en
    `DeploymentList` y vuelve a 0/5 ante cualquier fallo. Los focos pasan
    **59/59**; no se construyeron imágenes bot.
  - Evidencia live actual: el clúster recreado
    `cbff6246-9be0-498d-9938-c73534cf4b79` está `running` en `ams3`, DOKS
    `1.34.10-do.2`, un nodo `s-4vcpu-8gb`, HA desactivada, dos PVC `10 GiB`
    `Bound` y LB `178.128.139.203`. La secuencia
    `legacy-absent -> legacy-active` terminó con **12/12 Deployments Ready** y
    Lease libre usando Hubs legacy. Desmontaje antes de
    `2026-08-30 19:04:04 CEST`.
  - DNS/TLS/join: IONOS conserva TTL `300` y los cuatro A records staging
    apuntan a `178.128.139.203`; resolución local, Cloudflare y Google coincide,
    los cuatro certificados están `Ready` y HTTPS valida sin `-k`. La sala
    desechable `n7MiJAf` cargó Hubs legacy contra Reticulum v2 con una persona.
  - Correo de acceso: Mailtrap rechazó inicialmente
    `noreply@staging.meta-hubs.org` porque el subdominio no estaba autorizado.
    El generador admite ahora `SMTP_FROM_ADDRESS`, conserva por defecto
    `noreply@HUB_DOMAIN` y staging usa el remitente ya verificado
    `noreply@meta-hubs.org`. Generador **34/34**, manifiestos privados verificados
    y apply legacy-active verde; Mailtrap confirma el nuevo mensaje como
    **Delivered**. Producción no cambió.
  - Siguiente acción exacta: completar el login del buzón real IONOS ya abierto,
    usar el enlace sin exponer el token, importar en Spoke el proyecto v9
    recuperado, marcar la silla `Clickable`, publicar una escena staging nueva
    y crear la sala final. Después aplicar el manifiesto legacy-active candidato
    de Hubs v2.
- [ ] Ejecutar `tests/browser/sitting-occupancy.spec.mjs` con dos contextos y
  revisar manualmente `remote-seated-pose.png`.
  - Estado: **WAITING** de contenido Spoke, sala final y Hubs v2; DNS/TLS ya
    están verdes.
  - Aceptación: los once requisitos de producto pasan sin warnings ni errores.
- [ ] Conservar la evidencia no secreta y desmontar todo el staging con readback.
  - Estado: **WAITING** de éxito o fallo terminal de S4.
  - Hecho cuando: no quedan clúster, nodo, LB, volúmenes, firewalls DOKS
    gestionados, registros DNS ni contenido staging facturable/reutilizable;
    producción continúa idéntica.

### S5. Promover los mismos digests a producción

- [ ] Autorizar la ventana productiva exacta y crear checkpoint DB+medios.
  - Estado: **WAITING — efecto productivo**.
- [ ] Revisar el `kubectl diff` generado y aplicar Reticulum primero, Hubs
  después, sin cambios no relacionados.
  - Estado: **WAITING** de staging verde y autorización.
- [ ] Reiniciar Reticulum tras Hubs, ejecutar navegador frío desktop/mobile y
  `./deployment/verify-live-reactivation.sh` con cero fallos y cero avisos.
  - Estado: **WAITING** del rollout.
- [ ] Cerrar la feature con evidencia, commits/digests, rollback y estado humano.
  - Estado: **WAITING** de aceptación live.

## Rollback

1. Ante un fallo cliente/UX, volver primero Hubs al digest anterior.
2. Mantener Reticulum v2 y su tabla: acepta clientes legacy y evita una
   migración destructiva.
3. Si el fallo es exclusivamente Reticulum y Hubs v2 aún no se desplegó,
   conservar Hubs anterior y volver al digest Reticulum previo solo tras probar
   que no existen leases activos.
4. No borrar la tabla ni sus datos como rollback normal.
5. Conservar checkpoint y digests anteriores hasta cerrar aceptación.

## Estado de trabajo

- Completado: S0-S3, inventario/target/cost gate, builds, preflight privado,
  primer staging con join legacy, desmontaje/readback, perfil legacy activo,
  recreación exacta y 12/12 Deployments Ready con Hubs legacy.
- Activo: actualizar los cuatro A records al LB `178.128.139.203`, aceptar
  DNS/TLS, crear la sala desechable y repetir el join legacy; después Hubs v2 y
  E2E de dos navegadores.
- Ready: manifiesto Hubs v2 privado/verificado y arnés E2E de 11 requisitos.
- Waiting: aceptación de dos navegadores; S5 espera staging verde y una
  autorización productiva posterior.
- Bloqueos técnicos: ninguno; IONOS requiere reautenticación del propietario
  antes de editar los cuatro registros.
- Efectos externos realizados: rama Hubs `codex/sitting-v2` publicada, tres
  runs totales —un fallo causal, Reticulum verde y Hubs corregido verde— y el
  staging temporal exacto descrito arriba. El máximo planificado sigue siendo
  aproximadamente USD `0.09677/h`; el desmontaje debe empezar antes de
  `2026-08-30 19:04:04 CEST`. Producción continúa intacta.

## Reglas anti-loop

1. La implementación existente se conserva; no se crea “Sitting v3”.
2. Un PASS previo no se repite salvo que cambien sus inputs u oráculo.
3. Los focos actuales prueban source; solo staging prueba la carrera real.
4. No se usa producción como fixture ni se presenta sitting histórico como v2.
5. El target staging ya está fijado; no se reabre la comparación salvo que
   cambien precio, disponibilidad o topología.
6. Hubs y Reticulum son las únicas imágenes de esta release. No se construyen
   parent/runner para hacer pasar staging.
7. Un fallo local no autoriza push, build, deploy ni cambios de topología.
8. Si un build falla, no se crea DOKS. Si staging alcanza fallo terminal, se
   conserva diagnóstico y se desmontan solo sus recursos exactos para cortar
   coste; no se usa producción como alternativa.
9. La ruta durable no vuelve a ejecutarse con imágenes bot legacy. El perfil
   legacy activo ya pasó sus focos y su gate live; no se reabre esa transición
   salvo evidencia nueva.

## Artefactos clave

- Contrato humano: `features/sitting/README.md`.
- Implementación: `features/sitting/IMPLEMENTATION.md`.
- Aceptación: `features/sitting/TESTING.md`.
- E2E: `tests/browser/sitting-occupancy.spec.mjs`.
- Hubs: `hubs/src/utils/waypoint-reservation-coordinator.js` y sistemas/UI de
  waypoint.
- Reticulum: `hubs-cloud/community-edition/services/reticulum/lib/ret/waypoint_reservation.ex`
  y `hub_channel.ex`.
- Rollout: `deployment/README.md`.
- Estado humano: `docs/estado-sencillo.md`.
- Historial: `docs/session-changelog.md`.

## Punto de menor confianza

El punto de menor confianza ya no es fuente, credenciales ni manifiesto: es la
integración real de DNS/TLS y Reticulum v2 en un clúster nuevo. La versión
disponible es DOKS `1.34.10-do.2`, mientras producción conserva
`1.34.10-do.1`; comparten Kubernetes `1.34.10`, pero no son un clon byte-exacto
del proveedor. El control es crear solo el target autorizado, validar cada
generación y desmontarlo ante un fallo terminal sin usar producción como
alternativa. Decisión: **CONTINUE**.
