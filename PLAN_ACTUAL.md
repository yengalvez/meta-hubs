# PLAN ACTUAL — Creador de avatares dentro de YenHubs
Actualizado: 12 de septiembre de 2026.
Workspace actual: /Users/Shared/Gits/YenHubs-workflow.
Rama raíz: codex/proportional-workflow. La reparación visual ya está aceptada.

## Prioridad vigente del 12 de septiembre: terminar los pendientes

El propietario autoriza corregir todos los pendientes del cierre. No se reabre
el resultado visual, no se repite el despliegue y no se inicia otro respaldo.
El alcance es la generación local, las pruebas restantes y la integración Git.

- [x] Regenerar la copia local canónica de features con
  `cold-rebind-legacy-active-v1`: generación y verificador PASS, 44 recursos.
  Sin apply ni cambio productivo; los valores ya contenían el digest aceptado.
- [x] Aislar `BASE_ASSETS_PATH` y `RETICULUM_SERVER` dentro de la sección Spoke;
  AVA real pasa 68 pruebas y la regresión del ejecutor pasa 19 comprobaciones.
- [ ] Reproducir de forma focal el fallo antiguo de recuperación antes de
  repetir su sección: el caso post-ready no alcanzó la inyección, pero conservó
  cinco escritores a cero y el lock. Separar diagnóstico de inyección y seguridad
  sin rebajar ninguna condición de aceptación ni límite del monitor.
- [ ] Congelar las correcciones y ejecutar `./scripts/verify-project.sh --full`
  con la caché privada ya existente. Reutilizar únicamente recibos actuales,
  refrescar avisos caducados y revalidar las secciones invalidadas por estos cambios.
  El cierre incluye Spoke, Reticulum, recovery, H5 y el finalize de las 15 secciones.
- [ ] Integrar Cloud en master y después la raíz en main, sin reescribir historia,
  tras releer refs remotas y verificar punteros. Hubs master ya contiene `4b11be4b`,
  cuyo árbol coincide con la imagen visual aceptada.

La ejecución integrada antigua terminó con exit 1 en Spoke el 10 de septiembre;
static, security, HCCE, bot-orchestrator, Dialog, Photomnemonic y Coturn pasaron.
El diagnóstico antiguo 40262 también terminó: 898 PASS y un caso fallido, sin
certificar el candidato integrado. Ninguna de esas ejecuciones sigue activa;
se conservan sus logs y no se relanzan sin cambios ni se copian sus recibos.
La automatización está pausada hasta que exista una ejecución nueva comprobada.

## Antecedentes: cierre visual y flujo proporcional del 10 de septiembre

El propietario pide corregir las esperas desproporcionadas y después hacer una
única revisión de confianza, corrigiendo sus problemas materiales. Trabajo
aislado en `/Users/Shared/Gits/YenHubs-workflow`, rama `codex/proportional-workflow`,
desde raíz `8856868`, Hubs `bdf79ccec`, Cloud `cc52a184`. No alterar el candidato
de la prueba de recuperación ya activa (PID 40262) ni lanzar otro respaldo.

- [x] Clasificar una entrega exclusivamente visual del cliente contra el SHA
  realmente desplegado; cualquier ruta desconocida exige el circuito completo.
- [x] Validar cliente y límites del despliegue sin exigir pruebas de recuperación
  no afectadas. Conservar el cierre completo para servidor/datos/infraestructura.
- [x] Exigir comparación exacta del cambio productivo, digest anterior y ruta
  de reversión; sin excepción para cambios de datos, secretos o control plane.
- [x] Pruebas focales positivas/negativas, revisión independiente única y arreglo
  de hallazgos materiales; documentar comandos y límites reales.
- [x] Desplegar la entrega visual con el flujo verificado: Hubs `52fb6c5b`,
  reinicio de Reticulum sin cambiar su imagen y verificador vivo con cero fallos
  y cero advertencias. Configuración canónica de features actualizada en sitio.
- [x] Sentarse/levantarse/reubicarse/volver a sentarse mediante botones reales.
  Dos clientes reales coinciden en contacto posterior `[0, 0.69862, 0]` en el
  segundo asiento; levantarse libera ambas reservas. Posicionamiento inicial
  del participante mediante controlador para suplir teclado sin tecla sostenida.
- [x] Corregir y aceptar la cámara de primera persona de Creator. Hubs
  `bb624fa50` construido en Actions `34476571404`, imagen `3991885c` aplicada
  por la vía restringida. Reticulum reiniciado sin cambio de sus dos imágenes;
  verificador vivo: cero fallos/cero avisos. Navegador frío versión
  `69a4553dc3921b0e6cf9`, APP/AFRAME/escena cargados, sin errores JavaScript.
  La vista normal despeja cuello/pecho; al mirar abajo se ve exterior de ropa.
  Desplazamiento óptico local medido `[0,.1,-.115]`, sin modificar POV ni cuerpo.
  Dos clientes y dos ciclos de asiento conservan contacto `[0,.69862,0]`;
  levantarse elimina postura sentada en ambos. Participantes cerrados al acabar.
- [x] Regenerar la copia local canónica de features con el perfil
  `cold-rebind-legacy-active-v1`. Los valores ya apuntan a `3991885c`, pero la
  invocación local con `HCCE_TARGET_PROFILE=active` fue rechazada antes de generar.
  Error exacto: `HCCE_TARGET_PROFILE must be unset or exactly one audited legacy
  cold-rebind profile`. Corregido y verificado con autorización el 12 de septiembre,
  sin apply ni backup; no afecta al despliegue privado ya verificado.
- [ ] Cierre completo de integración, reanudado en la prioridad vigente superior.
  Los merges no reescritos de base
  están resueltos; Hubs `4b11be4b` ya está en master remoto y conserva exactamente
  el árbol de la imagen aceptada (`a93ac2c18ddfd8dd49e09da938a680cf742c7c5d`).
  Cloud `2077675` sigue en rama publicada, sin avanzar master todavía.
  El comprobador del candidato integrado conservó cuatro recibos y ejecutó
  siete secciones más antes del fallo de Spoke. La reanudación actual usa
  `--full` con esa caché aislada y decide vigencia por contenido, no por esta lista.
  Driver desacoplado: `~/.yenhubs-private/proportional-workflow-20260910/verify-integrated-candidate.sh`;
  estado y resultado en `integration.phase`, `integration.log`, `integration.exit`
  e `integration.finished` del mismo directorio. Para al primer fallo; sin
  relanzamiento automático, deploy ni backup. Los cambios documentales de cierre
  exigirán únicamente recibos actuales de sus secciones afectadas.
  La prueba antigua PID 40262 no es un requisito de esta integración ni puede
  certificarla; conservarla como diagnóstico y no modificar su checkout de
  features mientras siga activa. El nuevo candidato tiene otro cierre de fuentes
  y ejecutor: no copiar ni aceptar los recibos del antiguo para certificarlo.

Esta prioridad sustituye la secuencia automática de checkpoint del texto
histórico inferior, pero no autoriza omitir aceptación visual ni inventar un
respaldo válido. La automatización existente solo conserva/observa la prueba.

La única revisión independiente encontró y se corrigieron dos fallos materiales:
errores tempranos ocultables por Bash y bloqueo por procesos de otro checkout.
Regresiones focales pasan. No repetir la revisión ni recuperar recibos antiguos
del harness modificado; revalidar las cuatro secciones del cliente. El modo
dry-run del aplicador se contrastó con las 44 entidades productivas; el apply
guardado posterior terminó correctamente. Cloud `2077675`, raíz `6d99216`.
Cuatro secciones del cliente y comprobación final de sus recibos pasan, aisladas
por hash del harness para no pisar evidencia del proceso antiguo. No hay nuevo
respaldo conjunto, ni se certifica con este circuito la recuperación completa.

Las dos vistas internas requieren `?allow_multi=1`, opción ya existente del
cliente; sin ella una pestaña termina la otra por diseño. No cambiar preferencias
persistentes para esta prueba. Los ensayos de cámara y ocultación del observador
son temporales del navegador y se eliminan recargando, nunca mediante hotpatch
de producción. El único proceso de recuperación sigue preservado y monitorizado.

Estado productivo final del bloque visual: imagen Hubs
`ghcr.io/yengalvez/hubs@sha256:3991885c9aac6331d718578dc01e6f9d66531502642a6eb2d9ef0abb868a0b9a`.
Reversión disponible y verificada: `52fb6c5bfff5e02bcf93ed153d185ffe772a72b99755ac4c8c7b3983142f950d`.
No hay nuevo checkpoint conjunto ni certificación de recuperación completa.
Las secciones inferiores conservan antecedentes: no son una orden para repetir
despliegues, respaldos o pruebas visuales ya aceptadas en este bloque.

## Cierre solicitado el 10 de septiembre

El propietario pide terminar los avatares y permite Blender CLI/MCP con capturas.
El resultado sigue siendo ropa/manos y contacto del asiento correctos en sala,
no mejorar el subsistema de recuperación. Producción comprobada el10sept sigue
en014b76a0; candidato cliente bdf79ccec/imagen52fb listo y sin cambios nuevos.
La secuencia77876 pasó static y security, pero no terminó recovery: el proceso
caffeinate desapareció el9sept12:53:21 local y el log acabó con pérdida de Lease
tras303 comprobaciones, sin recibo PASS. No hay proceso activo ni respaldo nuevo.
Reanudar solo recovery/h5 y avisos caducados con ejecución desacoplada de la
sesión, conservando logs y resultado terminal; no modificar el respaldo salvo
un fallo reproducible nuevo. Después checkpoint, despliegue y aceptación visual
local/remota. La sesión Blender avatar-workbench tiene cambios sin guardar:
se conserva intacta; las copias y capturas anteriores siguen disponibles.

## Ampliación vigente: ropa durante movimientos (8 septiembre)

El propietario autoriza un único reintento de checkpoint con diagnóstico ampliado
y pide usar Blender Metaverse para corregir las intersecciones de ropa al moverse.
Añade expresamente revisar las manos, que parecen adelantadas y poco naturales:
comprobar posición y orientación en idle, marcha y sentado, en ambas bases;
separar rig/retarget/clip de postura arbitraria del visor antes de corregir.
Primero se revisan copias compuestas de los GLB actuales en Blender y en el motor;
no modificar la sesión `avatar-workbench.blend` ni el checkout histórico sucio.
El respaldo final queda detrás de la congelación del candidato de ropa para evitar
otra pausa productiva redundante. No desplegar dba93430e por sí solo y dar por
cerrada esta ampliación: ese candidato solo corrige copias de geometría.

- [x] Inspeccionar pesos, geometría y ajustes runtime de ambas bases;
  reproducir intersecciones en prendas seleccionadas sin superponer el catálogo.
- [x] Corregir la causa localizada en copia preservando rig, materiales, UV y
  créditos; comprobar brazos arriba, codos, giros, cadera/rodillas sentadas y marchas.
- [ ] GLB reimportado y componente local verificados; falta sala con avatar guardado
  y observador. Evidencia local: 50 contratos/ajustes idempotentes, diez conjuntos
  Blender, 28 tests focales, nombres productivos y tres ciclos por base sin deriva.
- [x] Congelado Hubs bdf79ccec y raíz bf38e08, publicados. Full81057 exit0:
  quince secciones PASS; Actions34260275857 SUCCESS, imagen52fb6c5b.
- [ ] ACTIVE: reparar el respaldo y completar despliegue/contacto azul/integración.
  El único reintento autorizado83438 terminó exit1: storage-backup/stream,
  detalle `cancellation-reserve` durante running. No hay respaldo conjunto válido.
  Cinco escritores reanudados1/1, bloqueo de operación ausente y Lease libre
  comprobados18:18UTC. No desplegado. Seguimiento reactivado tras autorización.
  El propietario ordena después reparar lo incorrecto y continuar sin pedir de
  nuevo permiso por esta reparación. Reproducir/corregir la causa manteniendo
  protecciones, validar y hacer el respaldo corregido antes de desplegar.
  Una revisión independiente acotada cubre el supervisor; no reabre avatares.
  Corrección local: suprimir lecturas repetidas de la misma autoridad conservando
  lectura privada/hash/vínculo exactos y los plazos existentes. Prueba focal67849:
  47 PASS, incluidas tres capacidades durante20s y cancelación/reaping antes10s
  al congelar una. Validación completa del candidato corregido pendiente.
  Full79373 terminó con doce secciones PASS y static/recovery/h5 FAIL: anotación
  ShellCheck, exigencia de Git limpio y carrera de la prueba SIGKILL entre una
  renovación ya iniciada y su confirmación. La prueba ahora exige salida del
  heartbeat exacto, como máximo una CAS en vuelo y versión estable después;
  conserva la comprobación del grupo de copia eliminado. Sin cambio del Lease
  productivo. Guardar candidato limpio y repetir solo secciones invalidadas.
  La secuencia90464 terminó: static/security PASS, recovery FAIL. Tres casos de
  storage no inyectaron el fallo porque su mutador vencía a90s y el stream
  arrancaba después; rendezvous local corregido a300s y copia simulada acotada
  a30s sin marcador de revocación al vencer. El límite real de cancelación sigue
  en10s. El último escenario perdió Lease durante reposo del Mac (04:25–04:42UTC,
  confirmado por pmset); ejecutar las pruebas con caffeinate ligado al comando.
  Foco63586 rechazó correctamente el árbol sucio antes de probar la corrección:
  guardar candidato limpio antes del foco y del gate; no cuenta como aceptación.
  Focos39958/45042 fallaron durante preparación; diagnóstico exacto launch/
  cancellation-reserve. La alineación ahora incluye identidad y continuidad
  antes de medir el margen, sin duplicarlas después salvo Lease externo.
  Foco11799: 95 PASS y ShellCheck-x26861 PASS. Incluye demora de continuidad
  antes del margen, tres capacidades reales y revocación acotada comprobada.
  Las pruebas usaban time.monotonic de Python3.9/mac con origen por proceso:
  sustituido solo para estampas compartidas por CLOCK_MONOTONIC del sistema,
  comprobación entre procesos y rechazo de tiempos negativos. Los antiguos
  PASS temporales con ese reloj no bastaban; el foco nuevo los revalida.
  Próximo: candidato limpio, tres inyecciones storage, secciones y finalize;
  aún no hay nuevo respaldo productivo ni despliegue.
  Foco38503 sí creó el checkpoint local, pero la restauración se detuvo antes
  del stream: guard-baseline/guard-stale:0:10087:3. El guard inicial envejecía
  durante otras auditorías y se aplicaba prematuramente el límite de ejecución.
  Ahora exige otro incremento dentro del plazo inicial ORIGINAL, sin reiniciar
  su reloj; la ejecución conserva diez segundos. Foco60464:95PASS; regresión
  93748:51PASS, incluye demora inicial11s y exige actualización nueva.
  Congelar esta corrección y revalidar las tres inyecciones antes del gate.
  Diagnóstico posterior2659: refresh/stream-identity antes de copiar. Revisión
  acotada confirma un plazo global no aplicado en todas las ramas e identidad
  duplicada; corregidos sin ampliar plazos. La consulta Lease externa y su
  observación final ahora quedan dentro de la alineación, antes del margen.
  Foco49749:97PASS y ShellCheck posterior PASS, ejecutados en serie. Incluye
  caducidad absoluta sin abrir el gate, índice del guard en el diagnóstico y
  GET lento realmente iniciado antes de congelar progreso, con revocación<5s.
  Job5031 terminó exit0: tres casos storage inflight-pid, inflight-progress e
  inflight-authority, 50 PASS cada uno. Todos crean el checkpoint por la ruta
  real local, inyectan tras iniciar el stream y comprueban reaping<10s con
  lock, fence y frontera cero conservados. Faltan secciones/finalize y producción.
  Full/build nuevos del cliente no son necesarios
  para los mismos bytes de Hubs; si cambia el código de respaldo, validar ese cambio.

Evidencia conservada: dba93430e y raíz 5ea6ea80 pasaron full completo; Actions
34245178065 terminó verde, digest 93114a9abebd526fb38f925616b303dd30c8afd04ea95ea7d1b949223fb6dbc5.
El checkpoint posterior falló en stream de medios (causa exacta aún desconocida),
restauró los cinco escritores y liberó locks. Producción sigue en 014b76a0.
El reintento posterior falló como se indica arriba; imagen nueva lista pero sin
desplegar. Registro diagnóstico privado: clothing-blender-20260908/
checkpoint-diagnostic-retry.private.log. No atribuir aún el fallo a red/archivo:
la evidencia concreta es falta de margen de cancelación del supervisor.

## Asiento: medición nueva del 8 de septiembre

Sala solicitada: `dCTfKVK`, segundo asiento `Seat_recovery_2_-_REPOSITION`.
Comprobado en navegador interno y Spoke `qa3U3Ke`: posición publicada
`[1.565976,-0.406443,0.415660]`, yaw -106.112°, escala 1; no se ha movido.
Avatar `wB3FSNL` sentado: Hips mundial `[1.369561,0.140855,0.364426]`.
En coordenadas del marcador: Hips `[0.005287,0.547298,0.202918]`, rig
`[0,0,0.15]`. El controlador usa ojos de pie (1.6 m y 0.15 m adelante),
después el clip baja la pelvis; no hay calibración de contacto de asiento.
No resolver con una constante arbitraria de 30 cm ni editando la silla.

Referencia confirmada expresamente por el usuario: JUSTO ENCIMA DEL TRIÁNGULO
AZUL, cara superior y=0.69862 del helper; NO bajo del torso gris (y≈0.902).
No confundir el centro articular Hips con la superficie de las nalgas.
Corrección candidata LOCAL: medición de superficie posterior de pelvis sobre
copia del rig en pose final, alineación del POV/rig por matrices y desbloqueo
del IK antes de resolver la nueva posición. Prueba matemática de yaw/escala
y asset real PASS; contacto calculado en editor masculino/femenino. Aún falta
aceptación visual, transiciones y réplica remota; NO desplegado. Preservar
avatares legacy y reservas. La sala se desconectó
después de obtener estas mediciones; no es evidencia de un fallo del rig.

Continuación autorizada: terminar y verificar en sala, sin pausa por mera
finalización local. Regresiones con controlador/IK/childMatch reales: 4 PASS
(dos superficies, sentado→sentado, levantarse, modelo tardío, llegada animada,
orden de réplica y legacy); superficie clonada: 2 PASS; geometría/matrices: 2 PASS.
La prueba real detectó y corrigió el acceso a cámara: pertenece a `ik.ikRoot`,
no a `ik`. No considerar el PASS matemático anterior como prueba de integración.
Candidato congelado Hubs: `9f7c858ac32ce8e342a88b5a2548490f9485a735`.
Hook: 157 tests PASS, lint/HTML PASS. Gitleaks raíz/Hubs sin secretos.
Ejecutar el único `--full` con caché privada de recibos existentes; no iniciar
checkpoint en paralelo porque el guard de procesos invalidaría los recibos.

- [x] Referencia azul y corrección local con regresiones focales.
- [ ] Congelar candidato corregido, ejecutar único `--full` con reutilización de recibos
  exactos y construir una imagen oficial de ese SHA; no modificar durante gates.
- [ ] Crear checkpoint DB+medios previo al cambio, comprobar retorno de escritores,
  generar/diff/aplicar manifiesto con solo la imagen Hubs nueva y reiniciar Reticulum.
- [ ] En navegador interno: avatar ya guardado, asiento editado, levantarse,
  volver a sentarse y observador. Verificar contacto en espacio del marcador.
- [ ] Registrar resultado real y cerrar integración del cambio, sin reabrir H5
  ni infraestructura. Si un gate falla, reparar causa demostrada antes de otro intento.

### Aceptación real del 8 de septiembre: copia local/remota de prendas

El candidato `9f7c858ac` pasó el gate completo (sin excepción Hex), se construyó
en Actions `34233957940` y se desplegó por manifiesto protegido con checkpoint
DB+medios completo. Imagen `sha256:014b76a0766d81f7c1523702c64c0b91ca1c6f2f998db576847dc2b646541a71`.
Verificador vivo: cero fallos y cero avisos. Esto NO cierra la aceptación visual.
Dos sesiones internas, misma sala y avatar guardado, mostraron matrices de rig
idénticas pero distinta geometría de chaqueta: contacto local exacto sobre azul,
contacto remoto desplazado 9,38 cm lateral y 1,86 cm vertical.
Causa demostrada: `BufferGeometry.clone()` comparte `userData` en este Three.js;
la marca de ajuste contaminaba geometrías cacheadas/headless sin ajustar sus
vértices. Corrección focal: copiar `userData` antes de marcar la geometría nueva.
Regresión de caché/local/headless/remoto: cada copia se ajusta exactamente una
vez, conserva fuente y coincide; 7 tests focales PASS. Falta congelar, gate,
build oficial y repetir aceptación local/remota tras el despliegue corregido.

## Estado vigente — reparación visual solicitada el 7 de septiembre

La observación del propietario invalida la aceptación visual anterior, no el
guardado, la privacidad ni la infraestructura. No está terminado este bloque.
Se conservan los cierres funcionales anteriores; no repetir H5, G2 ni recuperación.

### Punto de continuación: imagen desplegada, aceptación visual pendiente

Nueva observación del propietario: piernas Y brazos incorrectos al avanzar,
retroceder y moverse lateralmente. Se reabre la aceptación de locomoción completa,
no solo pose sentada. Reparación local en curso: elegir dirección en el marco
del cuerpo +Z, no del contenedor player-info; test de cuatro direcciones y cinco
giros pasa. Esto no demuestra todavía que el retarget de todos los clips sea
correcto. Revisar los GLB reales y brazos/piernas en las cuatro animaciones,
ambas bases, antes de otro build/despliegue. Harness local ampliado a cuatro
direcciones; revisión causal acotada solicitada al revisor de rig existente.
No fusionar PR9/PR32 ni declarar cierre mientras persista este defecto.

Diagnóstico nuevo demostrado: el filtrado de Hips/Spine elimina rotación de la
que dependen las pistas locales de extremidades; desviaciones hasta42,59°.
Helper local compensa ancestros omitidos solo para creador, sin animar torso;
selección de dirección usa orientación corporal. Recheck independiente de ambos
GLB y cuatro marchas: error máximo0,010062°, sentado intacto y sin doble aporte
de ancestro retenido. Regresión incorporada con ocho casos de assets reales más
cuatro casos de dirección/compensación; PASS. No es aceptación en sala.
Muestra interna local actual: http://127.0.0.1:50317/ (terminal98582), controles
Caminar/Atrás/Izquierda/Derecha. Aún sin nueva imagen ni despliegue. Falta terminar
aceptación visual completa y validación de candidato antes de publicar. La muestra
también deja visible intersección del polo con pantalón: no declarar todas las
prendas visualmente aceptadas por corregir orientaciones articulares.

Hubs `7556174efe55855319e379c1c6aa7c14f5629a3f` está desplegado con digest
`8f826b834e68fd401920df759e6a51cd6e8d934356083f38ea2023eeb2880631`.
Static/Hubs/security/browser-capacity PASS y finalize52496 exit0 sobre raíz
`c4973e7`; esta actualización posterior es exclusivamente documental.
Checkpoint completo1301s y cinco escritores reanudados. Apply58101 exit0,
Reticulum11492 Ready y verificador67434: 0 fallos/0 avisos.
Spoke publicado en `f6VKtim`: ambos asientos conservan posición/rotación y
`willMaintainInitialOrientation=false`, comprobado en el GLB servido.

La adaptación del rig reconoce el marcador dentro de Group/Bone; conserva la
clavícula, corrige la referencia de altura y separa chaqueta/pantalón sin alterar
pesos ni avatares importados ajenos al creador. Ambas bases probadas en local.
Esto NO cierra todavía los cuatro defectos: falta inspección cercana en sala con
los avatares ya guardados `wB3FSNL` y `oDvn9Qt`, de pie y en ambos asientos.
El navegador interno informó que el Mac está bloqueado. Pedir solo desbloquearlo;
el agente realiza la prueba. No abrir Chrome externo ni repetir acceso/guardado.
Después de aceptación real, integrar Hubs PR9 y raíz PR32 y cerrar documentos.
No repetir build, respaldo, despliegue, suites verdes ni recuperación.
Evidencia privada: `~/.yenhubs-private/avatar-visual-repair-20260907/`.

- [ ] Espalda: reproducir los triángulos y distinguir normales, capas o skinning;
  corregir la causa y comprobar frente/espalda/lateral en ambas bases con ropa.
- [ ] Hombros: la revisión independiente reproduce elevación de 2–3,4 cm por
  alinear clavículas; excluir esa compensación de referencia, probar y ver.
- [ ] Manos: comprobar el avatar real y su marcador de rig, reproducir la palma
  hacia atrás y corregir el espacio/orientación causal, no una rotación arbitraria.
- [ ] Silla: contrastar ancla publicada, pelvis y geometría de asiento; corregir
  solo el componente o contenido causante. Reservas Sitting permanecen cerradas.
- [ ] Validar cambios afectados, integrar y desplegar por ruta protegida con
  checkpoint previo; comprobar cada defecto en sala, también con GLB ya guardado.

No ampliar prendas ni proveedor. Pruebas locales de postura no sustituyen la
posición en la silla real. No declarar aceptación por isSitting=true, tests verdes
o una captura lejana. Registrar resultados concretos y límites antes del cierre.

## Cierre histórico — 6 septiembre, antes de los defectos visuales comunicados

Este bloque conserva evidencia anterior; la aceptación visual queda reabierta arriba.
- [x] Credencial Mailtrap antigua retirada por el usuario y ausencia verificada;
  nueva credencial conservada. Acceso IONOS resuelto autónomamente.
- [x] Validación exacta completada: terminal53735 exit0, static/security/hubs/
  browser-capacity PASS y finalize aprobado; advisories y diez bloques previos reutilizados.
- [x] Imagen71fa7209 desplegada por generador/apply protegido, digest1d6f8e21807b2303f4ac2c613065583bb230bbf218652638f496b26d64973814.
  Solo cambió imagen Hubs y hash de control; secrets sin cambios. Reticulum Ready
  antes de verificador70056: 0 fallos/0 avisos. Versión UI7bf6375f.
- [x] Masculino oDvn9Qt y femenino wB3FSNL guardados y seleccionados en sala;
  persistencia, sentarse/levantarse y recepción remota comprobadas. DB: ambos
  activos, mismo propietario G2, flags privados, cero listados, tres archivos activos.
- [x] Editor productivo 390x844 sin desbordamiento horizontal; controles legibles,
  preview femenino con traje y rubio, Guardar accesible. Muestra cancelada, sin
  un tercer avatar. Es prueba responsive de escritorio, no dispositivo físico.
- [x] Integrar PR Hubs8 y gitlink raíz: Hubs8 fusionada en e9d57e403;
  raíz30 fusionada en 731af3869, remoto comprobado con Hubs71fa7209 y Cloudcc52a184.
  Cierre funcional e integración completados; esta entrega registra el cierre documental.
No repetir suites, despliegue, respaldo ni recuperación. Evidencias de esta fase:
~/.yenhubs-private/avatar-rollout-20260906/{frozen-sections.private.log,
contrast-live-ready-verifier.private.log,female-live-evidence.md,
credential-retirement-confirmed.md,contrast-rollout-completed.md}.

## Resultado
Al entrar en una sala, el usuario podrá elegir un avatar existente o crear uno
personalizando un personaje con assets incluidos, verlo y guardarlo directamente
en Mis avatares. Se busca la alternativa gratuita más rápida y mantenible a RPM.
Crear significa modificar rasgos/apariencia; una subida manual o enlace externo
por sí solos no satisfacen el encargo. No se exige generación desde selfie.

Requisito visual confirmado por el propietario el 5 de septiembre: personajes
adultos de estilo Ready Player Me/Avaturn, adecuados para empresas. Debe haber
camisa y vestuario profesional (chaqueta/corbata); camiseta puede complementar.
No anime, chibi, cosplay ni ropa de fantasía. La túnica/explorador del prototipo
NO es un entregable aceptable. Reutilizar controles, composición y guardado;
sustituir los assets o el proveedor antes de publicar/desplegar. No repetir las
pruebas de lógica que no cambien; verificar licencia, apariencia y rig del sustituto.

Mínimo de personalización confirmado: cinco modelos distintos de prendas
superiores/camisas, cinco modelos distintos de pantalones y cinco peinados,
combinables por separado. Colores adicionales no cuentan como modelos distintos.
Un personaje prefijado o un selector de outfits completos no satisface el encargo.
Antes de ampliar código, inventariar esas quince piezas con licencia y rig aptos;
si un catálogo candidato no las tiene, no simular variedad mediante recolores.

## Alcance y autoridad
El propietario solicita análisis, elección, implementación, pruebas, integración
y montaje operativo sin interrupciones rutinarias. Incluye el despliegue en la
instancia existente y aceptación con cuentas de prueba ya disponibles.
No contratar planes, introducir costes ni crear infraestructura. Usar solo
navegador interno. No enviar fotografías personales a proveedores.
Conservar elección de avatares existentes e importación privada GLB.
H5, Sitting y G2 están cerrados; el plan G2 se conserva íntegro en
OLD/docs/PLAN_ACTUAL-glb-completed-2026-09-03.md.
El checkout antiguo /Users/Shared/Gits/YenHubs está sucio y se conserva intacto.

## Criterios de aceptación
- Creador accesible desde el selector en el vestíbulo y desde la sala.
- Personalización visual útil con assets de procedencia y licencia verificables.
- Gratuidad para el uso integrado destinado a clientes, no solo un trial.
- Preview, exportación GLB compatible, guardado privado y selección sin descargar
  y volver a subir manualmente. Cancelar no crea registros.
- Avatar persistente tras recargar; aislamiento por cuenta y ausencia del catálogo.
- Uso/pose/remoto y pantalla móvil; no invalidar las evidencias previas ajenas.
- Dependencias acotadas, sin credenciales en cliente ni confianza en mensajes ajenos.
- Publicación, imagen oficial, checkpoint DB+medios, rollout protegido y readback.
- Si ninguna vía satisface el alcance, documentar evidencia y límite concreto;
  no declarar imposible lo que solo requiere una integración razonable.

## Trabajo
- [x] Comparar opciones y fijar una vía gratuita para uso empresarial.
  MakeHuman CC0 y tres pantalones CC BY 4.0, inventariados en
  features/avatar-creator/wardrobe.json. Quaternius fue un prototipo descartado.
- [x] Implementar personalización 5+5+5, ambas bases, preview y guardado privado.
  Se conserva la selección existente y la subida GLB. Compositor con eliminación
  de recursos no seleccionados y créditos en UI/glTF; sin proveedor externo.
- [x] Incorporar ensamblador portátil y procedencia de assets.
  Hubs scripts/build-business-avatar-assets.py y normalize-business-avatar.mjs.
- [x] Comprobar lógica y build local afectados.
  126 tests y TypeScript verdes; ajuste posterior solo del jersey validado por
  las cuatro pruebas focales (300 combinaciones). Build de producción verde,
  con dos avisos de tamaño de assets/entrypoints. No se ejecutó --full.
- [x] Revisar una muestra en el editor real con backend local simulado.
  Masculino y femenino cargan; americana/lana/coleta genera GLTF 34,466 B,
  BIN 4,284,948 B y PNG 177,617 B (720x1280), flags false/false.
  Esta evidencia NO es persistencia productiva ni aceptación de sala.
- [x] Cerrar aceptación visual final, móvil y movimiento relevante.
  Completado según el estado vigente superior; se conserva debajo el diagnóstico histórico.
  Nueva evidencia del propietario: el botón de pose manual de la demo doblaba
  mal las piernas. Sustituido en el harness local por fullbody-locomotion real
  y los clips compartidos de Hubs; Sentarse/Levantarse/Caminar disponibles.
  La revisión posterior del propietario rechaza también la demo con clips Hubs:
  deformación de pecho y pie izquierdo, partes deformadas al sentarse y cuerpo
  elevado/brazos hacia atrás al levantarse. El diagnóstico de solo piel/polo
  era insuficiente. Animación NO aceptada; causa aún por demostrar.
  Próximo trabajo autorizado: reproducir y corregir localmente, sin pedir otra
  confirmación ni depender de SMTP. Comparar postura de reposo, orientación de
  huesos, pesos y transformación de clips; comprobar además que sit libera
  torso/cadera al volver a idle. Separar defecto del harness de defecto runtime.
  Probar cuerpo sin prendas y vestido, ambas bases: idle, caminar, sentarse,
  levantarse y repetir el ciclo sin deformaciones, deriva ni poses retenidas.
  Corregir la causa en el builder/retarget/runtime que corresponda; no ocultarla
  mediante máscaras de ropa ni cambios exclusivos del visor. Conservar controles,
  catálogo y guardado ya válidos. Pruebas focales y demostración visual antes de
  otro build. Corregir también pelo claro; ampliar vestuario queda para después.
  Investigación previa solicitada: documentación oficial MPFB Animation y
  operador mapmixamo.py de v2.0.17 confirman una etapa explícita de mapeo entre
  rigs (COPY_ROTATION y COPY_LOCATION para Hips). El loader actual de Hubs
  renombra tracks pero no compensa las orientaciones de reposo entre rigs.
  Los GLB actuales difieren en Spine2, LeftFoot y LeftUpLeg respecto a los clips;
  por tanto el nombre mixamo no acredita compatibilidad directa. Validar un
  retarget correcto antes de regenerar todo; revisar separadamente la salida de
  sit y sus tracks de torso/cadera. No se ha demostrado aún una solución final.
  Fuente: https://github.com/makehumancommunity/mpfb2/blob/master/docs/ui/operations/animops.md
  Preparado avatar-animation-retarget.js: cambio de bases de orientación antes
  y después de cada quaternion. Conectado al runtime solo para GLB del creador
  marcados makehuman-mixamo-v1; no publicado ni aceptado. Cuatro pruebas focales
  pasan. La cuarta cubre el fallo observado Missing animation bind bone:
  RightShoulder: los clips sin skin cargan Object3D, no Bone; la captura ya
  admite sus transformaciones con nombre. Demo interna 62267 confirma idle/sit
  reales activos. Inspección visual posterior: brazos aún incorrectos al volver
  a idle; el cambio de base por sí solo NO demuestra retarget visual correcto.
  Comparación controlada posterior: brazos incorrectos también en idle inicial,
  sin pasar por sit. Alineación A/T de hombro/brazo/antebrazo implementada usando
  direcciones articulares, sin cambiar assets; demo masculina muestra brazos a
  los lados en idle y junto a piernas en sit. Cinco pruebas focales y ESLint pasan.
  Captura adelantada antes del await para evitar contaminación por fallback;
  harness reconectado por identidad del avatar, no por escena persistente.
  Siguiente paso: comprobar vuelta a pie, ciclos, caminar, base femenina y
  prendas/cuerpo; aceptación visual completa aún pendiente, igual que sala real.
  Evidencia posterior de demo con componente real: tres ciclos completos por
  base retornan a idle con deriva máxima de posición 0 en Hips/Spine/Spine1/Spine2;
  diferencia angular máxima 0.000407 rad (masculino) y 0.000371 (femenino),
  constante en los tres ciclos. Femenino inspeccionado en idle/sit/walk con polo
  y chinos; no demuestra todavía cuerpo sin prendas, todo el vestuario ni IK/red
  de sala. Harness privado editor-local/entry.jsx incluye Verificar 3 ciclos.
  Pestaña interna conservada en http://127.0.0.1:62267/ (servidor sesión 79368).
  Pelo claro: corregidas las texturas oscuras de cinco peinados por base mediante
  prepare-creator-hair.cjs (Sharp offline); alfa verificado idéntico y contratos
  nodes/meshes/skins/accessors comparados intactos contra Git. Rubio claro visible
  en editor real masculino, con cuatro accesos a tonos y selector libre conservado.
  Cuatro pruebas del compositor pasan sobre los nuevos assets (300 combinaciones).
  Los cinco peinados claros ya se han inspeccionado en el editor: corto natural,
  corto con raya, melena y afro masculinos; coleta femenina. Guardado local nuevo
  femenino/coleta/chaqueta/chinos correcto: GLTF 34,873 B, BIN 5,230,092 B y PNG
  195,617 B (720x1280); 52 huesos y flags promoción/remix false. Sin persistencia real.
  Prendas: americana/corbata inspeccionada en sit, chaqueta cruzada inspeccionada
  sentada con zoom 2x y polo en idle ampliado. Sin la deformación de brazos/pecho
  anterior en esas muestras. Nueve pruebas focales pasan; el compositor verifica
  marca de rig y texturas preparadas en las 300 combinaciones. ESLint de los
  archivos de runtime/controles y tests modificados pasa. Estas muestras no
  sustituyen la comprobación de sala real.
  Candidato correctivo local Hubs 8c74e8c22: TypeScript y 131 tests pasan;
  ESLint, HTMLHint, Gitleaks staged y Actionlint pasan. El hook de commit volvió
  a ejecutar 131 tests automáticamente; no lanzar otra vez esos tests sin cambios.
  Publicado en codex/avatar-creator (PR Hubs #8 sigue en borrador). Build oficial
  único 33970705664 sobre 8c74e8c2256b921baaac163822a9effc225f3ff8 terminó verde
  el 5 de septiembre a las 14:09:11 UTC; tag avatar-creator-20260905-8c74e8c2-84.
  GHCR confirma versión 1212987062 y digest
  sha256:dcd6ae8728066322c4ef7252acb9b9744706d7c4c652bb2896093ea11c9901d8.
  No volver a construir estos bytes. SMTP sigue siendo requisito del rollout.
  Seguridad CI del SHA corregido verde: 33970683330 y 33970680748. Storybook
  33970680750 e imagen 33970705664 también terminaron verdes. No hay runs pendientes.
  El antiguo heartbeat resultado-imagen-creador-yenhubs ya no existe según la API;
  no se recreó. No hace falta seguimiento de estos runs terminados.
  No regenerar assets ni construir/desplegar otra imagen hasta resolverlo.
  Editor local móvil 390x844 verificado: controles, preview y guardado privado
  simulado pasan en ambas bases; falta uso/pose/remoto en la sala real.
  Diez renders verifican jersey con cada pantalón y ambas bases tras corregir
  intersecciones en cintura. Flexión artificial de piernas en visor demuestra
  que las prendas siguen al rig, NO acredita el protocolo Sitting de una sala.
- [x] Seguridad final, commit, publicación de rama Hubs e imagen oficial.
  Commit Hubs local 3987f8b6acce3aedb32fd3bf454dbdf9530df686, árbol limpio.
  Gitleaks (assets y staged), Actionlint y diff-check pasan. Build de producción
  local correcto con dos avisos de tamaño. Rama Hubs publicada; security-ci
  33928843627 y 33929030946 verdes. Imagen oficial única 33928876505 sobre
  3987f8b6 y test-and-deploy-storybook 33928843616 terminaron verdes.
  GHCR versión 1211442752 confirma tag avatar-creator-20260905-3987f8b6-83 y
  ghcr.io/yengalvez/hubs@sha256:f03df945f3206d3a19a1f54377986d8969e1912dbf09640f4e5bdcaa99275412.
  Digest coincide con salida del build; seguimiento pausado. No relanzar.
  Esa imagen prueba compilación, NO calidad de animación: no desplegarla con los
  defectos anteriores. Si la reparación cambia bytes productivos, congelar y
  validar el candidato corregido antes de construir una nueva imagen una vez.
  Documentación raíz guardada localmente en 2e49aa4, aún sin publicar.
  PR Hubs #8 abierta en borrador contra master; no fusionar como aceptada antes
  de la comprobación productiva. https://github.com/yengalvez/hubs/pull/8
- [x] Despliegue protegido y aceptación productiva.
  Completado con 71fa7209 y verificador70056; los estados siguientes son históricos.
  ESTADO DE REANUDACIÓN: run 34040735085 SUCCESS para 71fa7209db719c261c9ff7e0af0ba498e358403f;
  GHCR 1215697092, tag avatar-creator-20260906-71fa7209-86, digest
  sha256:1d6f8e21807b2303f4ac2c613065583bb230bbf218652638f496b26d64973814.
  Aún NO desplegado. Heartbeat pausado al terminar. Finalizador 47978 terminó:
  diez bloques válidos, faltan advisories/static/security/hubs/browser-capacity.
  Única secuencia para esos cinco iniciada en terminal 50586, log privado
  avatar-rollout-20260906/current-sections.private.log; consultar mismo handle,
  no repetir los diez bloques válidos ni relanzar esta secuencia.
  Terminal50586 terminó exit1: advisories PASS; static ejecutó sus comprobaciones
  sin errores pero rechazó el recibo: «Section inputs changed while static was running».
  Causa identificada: se editó este plan durante static, que incluye root completo.
  Seguimiento pausado. Conservar advisories y las diez secciones válidas anteriores.
  Siguiente secuencia: static/security/hubs/browser-capacity y finalize; no editar
  archivos versionados mientras se valida. Registrar avance fuera del árbol durante
  esa secuencia. No repetir advisories ni --full. Sigue pendiente la clave antigua.
  SEGURIDAD pendiente de acción humana: la clave SMTP anterior coincide de forma
  única con la fila Mailtrap 5477652, Sending Onboarding API token 19f61175ac1,
  que conserva permisos Account Admin. Comparación privada del sufijo visible;
  ningún valor completo se imprimió. La nueva fila 5550313, YenHubs SMTP septiembre,
  ya funciona y NO debe borrarse. Navegador interno pestaña20 tiene abierto el
  menú de la fila antigua (Delete token). La retirada final de una credencial
  mediante UI requiere handoff; el agente no la ha pulsado ni la da por revocada.
  No desplegar otra imagen hasta resolver esa clave antigua expuesta.
  NUEVO CANDIDATO VISUAL 71fa7209d: controles con contraste y fondo opaco.
  Validado con global.scss real en escritorio y iframe 390x844: personalización
  femenina y guardado local simulado correctos. Sass, webpack del harness,
  Gitleaks staged, Actionlint y 131 tests obligatorios del hook pasan.
  No implica todavía publicación/aceptación móvil productiva. No repetir tests.
  Publicado en rama Hubs; imagen oficial única 34040735085 en curso, prefijo
  tag avatar-creator-20260906-71fa7209. Raíz f25d0b0 guarda evidencias/gitlink.
  No relanzar. Si verde, verificar digest y desplegar solo esta imagen por el
  perfil protegido anterior; esperar Reticulum Ready antes del verificador.
  Pose/remoto del avatar masculino oDvn9Qt pasan en sala real: navegación nativa
  #Seat_recovery_2_-_REPOSITION reserva F0E14C01-EFF0-4976-B8B6-E0BEF1F9E1B2;
  componente local y segundo cliente reciben isSitting=true/acción sit. Al
  pulsar Levantarse, remoto recibe false/idle y vuelve a posición de pie normal.
  Capturas frontal y posterior sin el torso/brazos rotos anteriores. No forzar
  componente, ni editar transformaciones. Falta comprobación femenina/móvil
  productiva sobre el candidato visual, retirada de credencial antigua y Git.
  Método reutilizable: las dos pestañas deben llevar ?allow_multi (opción nativa
  onConcurrentLoad); sin ella Hubs cierra la sesión anterior al abrir otra.
  Sentarse se prueba mediante hash con nombre publicado, no con bucles de teclas.
  Observador 27 levantado al acabar: reserva null/isSitting false comprobados,
  pestaña temporal cerrada. Principal 1 permanece de pie y silenciada.
  Reconciliación de recibos iniciada una sola vez, terminal 47978:
  ./scripts/verify-project.sh --finalize --evidence-dir
  /Users/yengalvez/.cache/yenhubs/project-verification. Sigue ejecutándose sin
  salida final; solo lee huellas/recibos existentes, no lanza suites. Consultar
  ese mismo handle sin relanzarlo y registrar qué secciones faltan de verdad.
  DB read-only de oDvn9Qt: active, promoción/remix false, mismo propietario
  que G2 h2tMVFb, cero listings y tres archivos activos del propietario.
  El movimiento por pulsaciones instantáneas de CUA solo avanza centímetros;
  no multiplicar bucles de teclas para llegar al asiento. Input.dispatchKeyEvent
  CDP no está admitido: no usar rutas alternativas no autorizadas. La postura
  sentada/remota productiva sigue pendiente, sin evidencia de fallo de rig.
  Harness antiguo 62267 ya no escucha. Nuevo servidor local sesión 88860,
  http://127.0.0.1:53783/; /mobile mantiene iframe390x844. Pestaña interna26.
  Viewport override temporal restaurado. El harness ya importa global.scss y
  ui-root.scss reales: no volver a aceptar contraste desde el antiguo tema claro.
  ESTADO MÁS RECIENTE 6 septiembre 16:40 local: imagen 01859ab9b construida
  por run 34039159856 verde, GHCR 1215633585, tag con sufijo -85 y digest
  sha256:f85c52a2fc63b7c881cd2abc0a273fb0fc6ecd660f7bdfd5d8950a7a815eba82.
  Desplegada por gen-hcce/apply protegidos exit 0, sin cambios de Secrets;
  diff solo Hubs y huella de imágenes. Reticulum rollout status exit 0.
  Verificador definitivo layer-live-ready-verifier.private.log: 0 fallos/0 avisos.
  Primera comprobación lanzada antes de acabar el reinicio dio 5 fallos por
  servicio aún no Ready/HTTP 503; se conservó y repitió solo tras rollout success.
  Regla: esperar SIEMPRE rollout status antes del verificador, no en paralelo.
  Editor ya visible y guardado real correcto: YenHubs Empresa 20260906,
  avatar oDvn9Qt, masculino/corto con raya/americana y corbata/traje/rubio claro.
  Persiste en Mis avatares tras recarga; selección y aviso Tu avatar ha sido
  cambiado confirmados. Sala abierta con micrófono silenciado. No duplicar avatar.
  Aún pendientes DB/privacidad, representación/pose/remoto y móvil productivos.
  Defecto visual adicional demostrado: selects blancos con texto rgb(237,245,255)
  y fondo del editor rgba(8,16,31,0.76) deja ver el selector. Reparación CSS local
  sin publicar en avatar-editor.scss y ui-root.scss; Sass y diff-check verdes.
  No construir otra imagen hasta revisar juntos los problemas reales pendientes.
  Tercera persona no mostró avatar al probar; logs guardan SyntaxError JSON por
  respuesta HTML a las 14:37 UTC. Causa y vigencia aún por determinar; no atribuir
  al rig sin evidencia. Browser interno 2, pestaña 1, sala VJopCY3 autenticada.
  ACLARACIÓN posterior: no era fallo de tercera persona. APP/AFRAME/scene y GLTF
  oDvn9Qt cargados, modo cámara 5, escala y capas correctas. visibility.set(true)
  refrescó el canvas y mostró el avatar empresarial de espaldas. Las capturas de
  WebGL en segundo plano eran antiguas; hacer visible el navegador interno para
  aceptar animación. Sentarse devuelve Sin asiento a menos de 2 metros: mover
  al personaje junto a asiento antes de evaluar pose. No corregir cámara ni rig
  por ese falso indicio. El error JSON histórico queda por localizar si persiste.
  Seguimiento continuar-creador-tras-imagen-de-capas PAUSADO al terminar el build.
  ACTUALIZACIÓN 6 de septiembre 16:24 local: acceso RESUELTO. Por petición
  explícita del propietario se abrió webmail IONOS en navegador interno, con
  sesión conservada. Un enlace nuevo recibido a las 16:18 se usó inmediatamente;
  Verificación completa y sesión info@virtualmente.com confirmadas. No volver
  a bloquear por Mailtrap ni pedir al propietario que abra futuros enlaces:
  preparar primero IONOS y consumir el correo nuevo de inmediato.
  El enlace de un solo uso apareció en AX por un filtro de redacción insuficiente;
  no se conserva ni reutiliza. Se completó el acceso; filtrar cualquier URL
  con parámetros auth_, no solo la ruta /verify.
  NUEVA CAUSA PRODUCTIVA: el editor y MediaBrowser comparten z-index 70, y el
  selector posterior en DOM tapa los controles aunque AX los exponga. Captura
  real 704x994 y geometría DOM lo demuestran. No se pulsó Guardar ni creó avatar.
  Corrección acotada en ui-root.scss: editor a fullscreen+1, por debajo de
  popovers/modal. Sass y diff-check pasan. Se requiere imagen oficial correctiva,
  rollout protegido y comprobar visualmente editor por encima del selector,
  cerrar/regresar y guardado real. Reutilizar checkpoint fresco validado; no
  repetir rigging, assets, correo ni pruebas ajenas. No hotpatch productivo.
  Candidato Hubs 01859ab9b053779f9534ff479333d1399de5093f publicado; raíz
  19899ed conserva el gitlink. Build oficial único 34039159856 en curso desde
  14:26 UTC, tag avatar-creator-20260906-01859ab9. No relanzar ni duplicar.
  Al terminar verde: verificar digest, cambiar solo imagen Hubs, generar/revisar
  diff no secreto/aplicar con cold-rebind-legacy-active-v1, reiniciar Reticulum
  y probar editor visible y persistencia. SMTP y acceso ya están resueltos.
  Estado vigente 6 de septiembre: DESPLEGADO; aceptación autenticada pendiente.
  Checkpoint único checkpoint-pre-creator-20260906 completo: 361 tablas, 100
  migraciones, 18 salas y 39/39 pares. Exit 0, 1316 segundos; cinco escritores
  reanudados y bloqueo/Lease liberados. Hubo un timeout transitorio al reanudar;
  el procedimiento terminó correctamente y se comprobaron 12/12 servicios listos.
  gen-hcce y apply protegidos exit 0, perfil cold-rebind-legacy-active-v1;
  Reticulum reiniciado. Único cambio de Secret: SMTP_PASS. Diff no secreto:
  imagen Hubs y huella derivada del mapa de imágenes. Digest productivo:
  sha256:dcd6ae8728066322c4ef7252acb9b9744706d7c4c652bb2896093ea11c9901d8.
  Verificador live 0 fallos/0 avisos usando RESTORE_TARGET_MODE=cold-rebind y
  RECOVERY_CHECKPOINT_RUNNER_GENERATION=legacy-absent, contexto do-ams3-hubs-ce.
  Primera invocación detenida: se omitieron esas variables y eligió por defecto
  durable-active. Corregida solo la invocación, sin otro rollout ni cambios de código.
  Correo único a info@virtualmente.com Delivered el 6 de septiembre 13:41 UTC,
  remitente noreply@meta-hubs.org, API Key YenHubs SMTP septiembre: envío real
  con la clave nueva confirmado. La credencial antigua aún NO está revocada.
  El navegador bloqueó abrir la vista blob del texto del correo por política.
  No sortearlo mediante CDP, otro navegador o extracción alternativa. El propietario
  tuvo que intervenir entonces; ese bloqueo quedó superado por IONOS y el
  acceso autónomo de las 16:18. Después: guardado persistente, recarga, privacidad,
  uso/pose/remoto y cierre Git. No afirmar aceptación funcional completa.
  No repetir checkpoint, build, apply ni verificador sobre estos mismos bytes.
  Evidencia privada: ~/.yenhubs-private/avatar-rollout-20260906/.
  Comprobación pública posterior en navegador interno: carga fría del vestíbulo,
  Cambiar avatar y selector correctos; visibles Crear avatar, Subir GLB (privado)
  y catálogo existente. Crear avatar sin sesión exige autenticación y no crea
  registros. La pestaña original sigue esperando el enlace enviado; no se reenvió.
  Antecedentes de preparación, superados donde contradigan el estado anterior:
  Antes del rollout: rotación segura de SMTP_PASS por exposición histórica,
  checkpoint DB+medios, imagen/digest y manifest generado. Después, creación,
  recarga, privacidad y uso/pose/remoto en sala con navegador interno.
  No imprimir valores, no crear infraestructura, no repetir recovery ni H5.
  El 6 de septiembre el propietario completó la creación privada en Mailtrap.
  Comprobada presencia de la entrada Keychain account info@virtualmente.com,
  service YenHubs-creator-SMTP-20260905-01, sin imprimir su valor. No solicitar
  de nuevo su creación. Autenticación SMTP nueva aceptada con TLS y certificado
  verificado, sin enviar mensajes. Siguiente: checkpoint y sustitución por la
  ruta protegida. Conservar la credencial
  antigua hasta comprobar el envío con la nueva; después revocar la antigua.
  Presencia en llavero no equivale a validez SMTP ni a sustitución productiva.
  Incidente adicional durante preparación: un glob de búsqueda alcanzó el
  input-values.local.yaml ignorado y mostró SMTP_PASS. No conservar el valor;
  la sustitución pendiente es obligatoria. No volver a buscar con glob de inputs:
  usar exclusivamente rutas de fuentes trackeadas explícitas, nunca valores locales.
- [x] Cerrar documentos y Git tras comprobar el resultado real.
  Hubs8 y raíz30 fusionadas, punteros remotos exactos comprobados. Goal se completa
  después de verificar en remoto esta entrega documental; no requiere más pruebas largas.

Revisión independiente inicial de viabilidad/licencia ya realizada; evidencia en
features/avatar-creator/README.md. No repetir auditorías generales sin causa nueva.

## Estado y continuidad
Base comprobada limpia: raíz d4583be, Hubs 668413a20, Cloud cc52a184.
El Goal corresponde exclusivamente a este creador.
La evaluación de julio es antecedente, no veto permanente a la solicitud actual.
Investigar primero precio/licencia/export; parar investigación cuando otra fuente
no cambie la decisión. Un fallo repite solo el paso cuya causa se haya corregido.
No confundir tiempos de espera con trabajo que exige repetir suites.
