# PLAN ACTUAL — Creador de avatares dentro de YenHubs
Versión: v2 implementación. Fecha: 5 de septiembre de 2026.
Workspace: /Users/Shared/Gits/YenHubs-features. Rama raíz: codex/avatar-creator.

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
- [ ] Cerrar aceptación visual final, móvil y movimiento relevante.
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
- [ ] Despliegue protegido y aceptación productiva.
  Antes del rollout: rotación segura de SMTP_PASS por exposición histórica,
  checkpoint DB+medios, imagen/digest y manifest generado. Después, creación,
  recarga, privacidad y uso/pose/remoto en sala con navegador interno.
  No imprimir valores, no crear infraestructura, no repetir recovery ni H5.
  Mailtrap mantiene sesión interna; formulario Add API Token abierto sin guardar
  (settings/api-tokens/new). No se ha creado ni revocado ningún token. Requiere
  intervención del propietario para la credencial nueva; conservar la antigua
  hasta sustituirla por la ruta protegida y comprobar envío, después revocarla.
  Incidente adicional durante preparación: un glob de búsqueda alcanzó el
  input-values.local.yaml ignorado y mostró SMTP_PASS. No conservar el valor;
  la sustitución pendiente es obligatoria. No volver a buscar con glob de inputs:
  usar exclusivamente rutas de fuentes trackeadas explícitas, nunca valores locales.
- [ ] Cerrar documentos, Git y Goal tras comprobar el resultado real.

Revisión independiente inicial de viabilidad/licencia ya realizada; evidencia en
features/avatar-creator/README.md. No repetir auditorías generales sin causa nueva.

## Estado y continuidad
Base comprobada limpia: raíz d4583be, Hubs 668413a20, Cloud cc52a184.
El Goal corresponde exclusivamente a este creador.
La evaluación de julio es antecedente, no veto permanente a la solicitud actual.
Investigar primero precio/licencia/export; parar investigación cuando otra fuente
no cambie la decisión. Un fallo repite solo el paso cuya causa se haya corregido.
No confundir tiempos de espera con trabajo que exige repetir suites.
