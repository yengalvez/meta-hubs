# PLAN ACTUAL — Aceptación de avatares GLB privados

Versión: **GLB v1 — plan preparado; aceptación real pendiente**
Última revisión: **30 de agosto de 2026 (Europe/Madrid)**
Autoridad: **este fichero es la única cola ejecutable**.
El plan completo de Sitting v2 está cerrado y archivado en
`OLD/docs/PLAN_ACTUAL-sitting-v2-completed-2026-08-30.md`.

## Resultado y límite

Demostrar que un cliente puede cargar un avatar GLB compatible, verlo y usarlo
correctamente, guardado en su cuenta **sin publicarlo en el catálogo**.
Se acepta la función existente; solo se implementará una corrección si aparece
un fallo reproducible. No se construye un editor ni una integración de proveedor.

**Privado significa no listado**, no cifrado ni inaccesible mediante su URL:
otras personas en la sala necesitan poder representar el avatar.
La cuenta B no debe recibirlo en Mis avatares ni poder modificar el de A.
Los contratos primarios son `features/avaturn/README.md` y
`features/rpm-avatars/README.md`.

H5 y Sitting v2 permanecen terminados. No se repiten restore, `--full`,
staging, E2E de exclusión de sillas ni rollout por abrir este plan.
Bots, proveedores externos, upgrades upstream y limpieza DNS son trabajos
separados. Este plan no autoriza recursos nuevos, coste, publicación ni despliegue.

## Fuente y evidencia que se conservan

- Workspace: `/Users/Shared/Gits/YenHubs-features`.
- Rama local: `codex/private-glb-acceptance`, desde `origin/main`
  `34faabccb328df1faad75590401d7dfbb859311b` (cierre Sitting, PR #21).
- Gitlinks sin cambios: Hubs `0781a63091ac3160a1b473504dc655ac0b002735`;
  Cloud `db083d53e3d57c9380bbfefc6bd411e4d4bf4270`.
- El build Hubs [33245207737](https://github.com/yengalvez/hubs/actions/runs/33245207737)
  pasó sobre `b2697e7e6f571d195346cc156f0f1631eedc841a`.
  Los archivos del editor, selector, ayuda, validadores y español no difieren
  de ese corte. La interfaz neutral ya estaba incluida en la imagen publicada.
- El rollout aceptado de Sitting fijó Hubs
  `sha256:e8f9423ace1bf4108ae5a7ce59c1b45cf0b44b74ea944fdb82fee47e4d7be5b0`
  y Reticulum
  `sha256:256c292d0d5a69e021322bdbd11b3f318f2d44bee580433252e0b04ade1d5e18`.
  Su evidencia está en `docs/session-changelog.md`, bloque del 30 de agosto.
  No es una recaptura de Kubernetes ni una aceptación de subidas GLB.
- La lectura actual del navegador interno mostró el vestíbulo de
  `https://meta-hubs.org/VJopCY3/inicio`. No se entró, no se abrió el selector
  y no se subió/guardó nada: la UI específica y la persistencia siguen pendientes.
- La fuente fuerza `allow_promotion=false` y `allow_remixing=false`.
  Reticulum comprueba propiedad, credenciales de ficheros y tamaños;
  eso no demuestra por sí solo validación completa del rig en servidor.
- Hay 2 casos unitarios de textos neutrales y 3 de skeleton sintético.
  No equivalen a abrir GLB reales ni a guardar con dos cuentas.
  No se han repetido esas pruebas sobre código inalterado.

## Comprobaciones finitas de aceptación

Se reutiliza cada evidencia verde sobre los mismos bytes y condiciones. Una
corrección repite solo los casos que pueda invalidar.

1. **Dos positivos reales:** GLB 2.0 procedentes de dos pipelines distintos;
   entre ambos cubren upper-body compatible y full-body/Mixamo. Registrar
   procedencia/licencia, SHA-256, tamaño y rig. No cuentan mocks ni clips de
   animación sin avatar.
2. **Tres negativos:** corrupto, mayor de 64 MiB y sin skeleton compatible.
   Rechazo comprensible antes de guardar, sin crear avatar/listing.
   Probar los límites del servidor solo con focales locales, no mediante
   cargas maliciosas ni archivos gigantes en producción.
   Incluir localmente la transición **válido → rechazado**: Guardar bloqueado
   o archivo anterior conservado identificado inequívocamente; nunca guardar
   un archivo distinto del que la UI confirma. No basta empezar siempre vacío.
3. **Editor:** entrada neutral y ayuda visibles; preview y rig válidos antes
   de habilitar Guardar. La miniatura se genera durante el guardado y debe
   verse tras recargar. Repetir para cada positivo, sin aceptar preview vacío.
4. **Guardado de A:** reaparece tras recargar en Mis avatares y puede
   seleccionarse. Readback del avatar exacto: propietario correcto, ambos
   flags en false, cero `avatar_listing`, ausente de Featured/búsqueda pública.
5. **Cuenta B aislada:** no aparece en sus Mis avatares ni ofrece edición.
   El control API de modificación ajena se verifica con test local; no se
   intenta una escritura ajena en producción. Su visualización remota es
   esperada, no una filtración del listado.
6. **Uso real:** primera/tercera persona, idle/walk/run, sentarse/levantarse,
   manos, escala, orientación y contacto con suelo; B ve pose y movimientos
   coherentes. La pose se prueba con estos avatares, sin repetir la carrera
   de exclusión ya aceptada de Sitting v2.
7. **Carga fría y conservación:** escritorio y móvil con los nuevos avatares,
   sin errores ni warnings inesperados. Conservar los avatares preexistentes.
   No hay migración ni rollout para una aceptación sin cambios de código;
   si hay corrección, probar compatibilidad/rollback de datos localmente y
   preparar reversión del cliente, sin restaurar toda la DB como prueba.

## Cola ejecutable

### G0 — Cierre anterior y alcance

- [x] Confirmar main/gitlinks, rama limpia y cierre de H5/Sitting.
- [x] Guardar el plan Sitting exacto y registrar su sustitución en OLD.
- [x] Limitar GLB a aceptación existente y separar fuente de prueba live.
- [x] Revisión independiente única del plan: corregida la secuencia de
  miniatura y añadido el caso válido → rechazado. No hubo cambio de producto.
- [x] Validación documental: archivo Sitting byte-idéntico, diff-check,
  enlaces locales, Gitleaks de los siete documentos y Actionlint/ShellCheck
  de workflows raíz sin fallos; gitlinks inalterados. Sin suite de producto.

### G1 — Preparar archivos y una sesión acotada

- [x] Inventariar los dos GLB existentes más directos de las fuentes activas.
- [ ] **Primero, focal local válido → rechazado:** el catch de selección en
  `avatar-editor.js` conserva archivo/preview anteriores y el botón no usa
  `uploadError`. Es evidencia estática, no reproducción: comprobar el efecto
  observable sin subir datos. Si falla, resolver esa única causa por G3 antes
  de abrir una sesión productiva; no hace falta esperar archivos personales
  para una regresión local de estado.
- [ ] Obtener dos positivos reales autorizados/licenciados y registrar hashes.
- [ ] Preparar tres negativos locales y asignar cada criterio anterior a una
  observación; no crear otro arnés general si la comprobación directa basta.
- [ ] Fijar target, dos cuentas de prueba aisladas, archivos exactos, máximo
  **dos avatares nuevos**, conservación/retirada posterior y autorización de
  las escrituras. No reutilizar autorizaciones H5/Sitting como permiso GLB.
  Si se usa producción: checkpoint conjunto DB + medios válido antes de
  subir/guardar, según `deployment/create-checkpoint.sh`, sin restore de ensayo.
  No crear staging para salvar este paso sin una decisión separada de coste.

**Hallazgo del inventario:** `hubs/src/assets/models/DefaultAvatar.glb`
(829504 bytes, SHA-256
`ae8b624db8d7d713fb51b73159a228c4686210dc647fa826864ba11600af8abc`)
y `hubs-cloud/community-edition/services/reticulum/test/fixtures/test.glb`
son rigs legacy sin hombros/brazos/antebrazos requeridos por el importador actual.
No se usarán como positivos ni se rebajará el validador para hacerlos pasar.
Esto no demuestra que el avatar legacy ya guardado deje de funcionar.
Los clips Mixamo tampoco sustituyen un avatar full-body. No se usan archivos
de `OLD/` como entrada activa ni se buscan archivos personales fuera del alcance.

### G2 — Ejecutar la aceptación

- [ ] Con G1 cerrado, completar los siete criterios; anotar por caso archivo,
  fuente/digest, navegador/cuenta, resultado y evidencia no sensible.
- [ ] Readback final de los dos avatares y sus listados, y cierre de sesiones.
  Registrar si los avatares de prueba se conservan; no borrar automáticamente.

### G3 — Corregir únicamente si hay fallo

- [ ] Si G2 pasa sin cambios, marcar **no necesario** y saltar a G4.
- [ ] Si falla: conservar diagnóstico exacto, reproducir localmente, corregir
  la causa y ejecutar el foco afectado. Un cambio de contrato requiere revisar
  la decisión, no adaptar el test para que pase.
- [ ] Solo si cambian bytes de producto: usar las secciones afectadas del
  verificador y el procedimiento de build/digest/rollout de
  `deployment/README.md`, bajo el alcance de publicación/producción autorizado.
  No tocar nube por una corrección meramente documental.

### G4 — Cerrar sin otra ronda general

- [ ] Publicar evidencia no sensible de los siete criterios y residuos reales
  en estos documentos; no marcar completa la feature por fuente/unitarios.
- [ ] Actualizar estado humano y changelog; inspeccionar diff, enlaces y
  secretos. Integrar repos/punteros solo si hubo cambios y publicación
  autorizada. Para docs, validación proporcional; ningún `--full` nuevo.
- [ ] Terminar: no crear otro Goal, heartbeat, auditoría o tarea automáticamente.

## Próximo paso y parada

**Siguiente:** comprobar localmente válido → rechazado, obtener los dos
archivos válidos y concretar la sesión de G1. La preparación del plan está
terminada; la aceptación de producto no. No hay una prueba larga en marcha.

Se continúa sin preguntas entre comprobaciones locales reversibles.
Se pide solo lo que falte para una acción concreta: archivos con permiso,
cuentas/target y escrituras de la sesión; una autorización específica vale
para toda esa sesión mientras no cambien datos, destino, riesgo ni coste.
Una divergencia de identidad, secreto expuesto, pérdida de estado seguro o
fallo sin causa demostrable detiene los efectos, no reabre H5.
