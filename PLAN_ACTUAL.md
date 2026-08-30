# PLAN ACTUAL — Sitting v2 autoritativo

Version: **v8 — SITTING V2 ACEPTADO EN PRODUCCIÓN**
Ultima revision: **30 de agosto de 2026 (Europe/Madrid)**
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
- Hubs: PR #6 integró `b2697e7e6f571d195346cc156f0f1631eedc841a`
  en `master` mediante `0781a63091ac3160a1b473504dc655ac0b002735`.
  Es el corte funcional `ce8390a` más la corrección mínima de orden del
  Dockerfile demostrada por el primer build remoto.
- Cloud: PR #28 validó `4ead2a6` e integró su árbol en `development`; PR #29
  promovió ese mismo árbol a `master` mediante
  `db083d53e3d57c9380bbfefc6bd411e4d4bf4270`. Conserva la imagen Reticulum de
  `6d9ee9e` y añade la autenticación kubelet, el perfil legacy activo
  fail-closed y el remitente SMTP configurable demostrado en staging. Las
  imágenes de producto aceptadas no cambiaron.
- Los commits Hubs `9c2da562b` y `3f18bdf24`, Cloud `ce20e20` y el arnés raíz
  `875642e` son ancestros de esos cortes. La implementación, migraciones y E2E
  ya existen; no se reescriben sin un fallo causal nuevo.
- Producción usa ya los mismos digests aceptados en staging: Hubs
  `sha256:e8f9423ace1bf4108ae5a7ce59c1b45cf0b44b74ea944fdb82fee47e4d7be5b0`
  y Reticulum
  `sha256:256c292d0d5a69e021322bdbd11b3f318f2d44bee580433252e0b04ade1d5e18`.
  El rollout conservó el resto de imágenes y la topología recuperada.
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
11. No hay diagnósticos inesperados: excepciones de página, fallos first-party,
    requests fallidas ni HTTP `>= 400`. El arnés ignora únicamente firmas
    exactas ya clasificadas y cubiertas por unidad: `HEAD` abortado por el
    navegador, `/favicon.ico` 404, estados AEC, animación opcional `allOpen`
    ausente y el warning legacy de `background` de la escena recuperada.

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
Hubs/Reticulum, la ventana S4 completa de staging y la ventana productiva S5
con checkpoint, rollout escalonado y aceptación live. No se recrea staging ni
se vuelve a desplegar Sitting v2 sin evidencia causal nueva.

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
- [x] Desplegar staging en dos generaciones: Reticulum/migración conservando
  Hubs anterior, verificar compatibilidad legacy, y después Hubs v2.
  - Estado: **DONE**.
  - Evidencia: Reticulum v2 convivió primero con Hubs legacy; después el apply
    protegido promovió Hubs v2 por el digest candidato y el reinicio de
    Reticulum terminó con **12/12 Deployments Ready**. No se construyó ni
    modernizó ninguna imagen bot.
  - Contenido: Spoke importó el proyecto recuperado como `FoRSj5D`, publicó la
    escena `uW635n9` y la sala final desechable fue `3E2enaA`. Solo `Seat
    recovery 1` quedó ocupable/clickable con identidad publicada; el segundo
    waypoint se corrigió antes de la aceptación al demostrar que era otra silla
    distinta, no una doble concesión.
  - Correo y join: el remitente staging usó el dominio ya verificado
    `noreply@meta-hubs.org`; Mailtrap confirmó **Delivered**, la cuenta real
    abrió el enlace y el join legacy previo ya había demostrado compatibilidad.
- [x] Ejecutar `tests/browser/sitting-occupancy.spec.mjs` con dos contextos y
  revisar manualmente `remote-seated-pose.png`.
  - Estado: **DONE funcional; revisión estética de la captura inconclusa**.
  - Evidencia: unidad browser **12/12** y E2E remoto final **1/1** en `47.1 s`.
    Dos contextos aislados demostraron una concesión, cero solapes, una única
    reserva privada, pose/posición remota coherente, Stand, relevo y limpieza al
    cerrar. El diagnóstico final quedó vacío después de excluir únicamente las
    firmas exactas cubiertas por unidad.
  - Límite explícito: `remote-seated-pose.png` fue generada y revisada, pero la
    geometría/cámara ocultó al avatar remoto. No contradice los estados y
    posiciones medidos, pero tampoco certifica visualmente intersecciones; S5
    debe inspeccionar la pose en su navegador frío antes del cierre comercial.
- [x] Conservar la evidencia no secreta y desmontar todo el staging con readback.
  - Estado: **DONE para todo recurso facturable; cleanup DNS sin coste pendiente**.
  - Readback exacto: ya no existen clúster
    `cbff6246-9be0-498d-9938-c73534cf4b79`, nodo `596177917`, LB
    `5fa4fbf7-0892-4680-9c87-59ad3f423d43`, volúmenes
    `2c7d2e05-a3d1-11f1-8219-5a97d562e708` y
    `2ba5fda3-a3d1-11f1-8219-5a97d562e708`, ni sus dos firewalls gestionados.
    Solo permanece el clúster productivo original con su LB y dos volúmenes.
  - Residuo no facturable: IONOS aún publica los cuatro A staging hacia la IP ya
    retirada `178.128.139.203`. El navegador interno perdió la sesión y Google
    Password Manager exige verificación física; no se eludió. La próxima sesión
    autenticada debe borrar solo los records `1493595267`, `1493595622`,
    `1493595798` y `1493595951` y leer su ausencia. No bloquea el cierre del
    gasto ni autoriza S5.

### S5. Promover los mismos digests a producción

- [x] Autorizar la ventana productiva exacta y crear checkpoint DB+medios.
  - Estado: **DONE**.
  - Evidencia: checkpoint atómico
    `/Users/yengalvez/.yenhubs-private/sitting-v2-production-20260830/checkpoint-pre-sitting-v2-20260830`;
    `SHA256SUMS` verifica DB, medios y evidencias. Conserva 356 relaciones, 94
    migraciones, 18 hubs y 33 ficheros activos con sus 33 pares de storage.
- [x] Revisar el `kubectl diff` generado y aplicar Reticulum primero, Hubs
  después, sin cambios no relacionados.
  - Estado: **DONE**.
  - Evidencia: ambos manifiestos privados pasaron el verificador generado con
    44 recursos; el diff redacted limitó la primera generación a Reticulum y
    configuración compatible, y la segunda añadió solo Hubs. El driver
    guardado terminó con **12/12 Deployments Ready** en ambas fases.
- [x] Reiniciar Reticulum tras Hubs, ejecutar navegador frío desktop/mobile y
  `./deployment/verify-live-reactivation.sh` con cero fallos y cero avisos.
  - Estado: **DONE**.
  - Evidencia: Reticulum se reinició tras Hubs; el verificador live terminó
    **0 fallos / 0 avisos**. En navegador interno frío, desktop y viewport
    móvil cargaron la sala. En desktop, el asiento publicado quedó
    `occupied:true`, `player-info.isSitting:true`, la UI cambió a
    **Levantarse** y la tercera persona mostró el avatar sentado. No hubo
    errores de Sitting; se conserva el warning legacy `background` ya
    clasificado y un error de un medio roto de la escena que solo apareció al
    apuntar deliberadamente a ese objeto y no pertenece a esta feature.
- [x] Cerrar la feature con evidencia, commits/digests, rollback y estado humano.
  - Estado: **DONE**. La documentación y los punteros se integran en el cierre
    final sin repetir `--full`, recuperación ni E2E.

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

- Completado: S0-S5, incluidos builds, staging, carrera real, desmontaje,
  checkpoint productivo, diff, rollout Reticulum/Hubs, restart, verificador
  live y aceptación fría desktop/móvil con comprobación de reserva y pose.
- Activo: integrar en la raíz estos dos commits `master` y la documentación de
  cierre. No se repite ninguna prueba verde ni se vuelve a desplegar.
- Ready: Hubs y Cloud ya están integrados; Sitting v2 está funcional en
  producción y la raíz queda lista para fijar los punteros exactos.
- Waiting: nada de producto ni producción.
- Residuo: borrar cuatro A records staging sin coste cuando IONOS esté
  autenticado y leer su ausencia; no requiere clúster ni impide que el gasto
  temporal sea cero.
- Efectos externos realizados: rama Hubs `codex/sitting-v2` publicada, tres
  runs totales —un fallo causal, Reticulum verde y Hubs corregido verde—,
  staging temporal ya eliminado y rollout productivo de los mismos dos digests.
  No cambió la topología productiva ni se creó gasto recurrente adicional.

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

No queda una duda material sobre Sitting v2: la exclusión multiusuario pasó en
staging, los mismos digests están en producción, el verificador live quedó en
cero y la sesión fría confirmó reserva, estado sentado, UI y pose visible. El
único residuo es borrar cuatro A records de staging hacia una IP ya retirada;
no sirve tráfico, no cuesta dinero y no afecta a producción. Decisión:
**cerrar Sitting v2 y pasar a la siguiente feature**.
