# PLAN ACTUAL — Creador de avatares dentro de YenHubs
Versión: v3 reparación visual. Fecha: 7 de septiembre de 2026.
Workspace: /Users/Shared/Gits/YenHubs-features. Rama raíz: codex/avatar-visual-repair.

## Estado vigente — reparación visual solicitada el 7 de septiembre

La observación del propietario invalida la aceptación visual anterior, no el
guardado, la privacidad ni la infraestructura. No está terminado este bloque.
Se conservan los cierres funcionales anteriores; no repetir H5, G2 ni recuperación.

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
