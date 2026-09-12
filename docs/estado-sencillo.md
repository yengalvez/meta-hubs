# Estado sencillo de YenHubs

Ultima actualización: **12 de septiembre de 2026**

## Trabajo actual: creador de avatares

Las correcciones de ropa, manos, asiento y cámara ya están desplegadas. La sala
pasa la comprobación del servicio con cero fallos y cero avisos. Dos conexiones
reales coinciden en el apoyo del avatar sobre el asiento, también después de
levantarse y volver a sentarse. La vista normal ya no atraviesa cuello y pecho.

Los cambios exclusivamente visuales tienen ahora una vía verificada que no
repite las pruebas largas de recuperación ni otro respaldo completo. Los cambios
de servidor, datos o infraestructura conservan sus requisitos de seguridad.

La copia local de recuperación ya está regenerada y verificada. También está
corregido el entorno de pruebas de Spoke: sus 68 pruebas pasan. Falta cerrar la
validación completa e integrar las ramas publicadas. El caso fallido de
recuperación pasa ahora 48 comprobaciones aisladas: el error simulado sí se
provoca y los cinco servicios permanecen bloqueados de forma segura.
No se repite el despliegue visual ni se afirma que exista un nuevo respaldo conjunto.

### Antecedentes del 8 de septiembre, superados por el estado anterior

Ampliación actual: la ropa y las manos ya tienen una corrección local revisada
con Blender y el navegador interno. Se han comprobado 50 combinaciones de ropa,
diez conjuntos representativos en varias poses y ambas bases caminando y sentadas.
Las manos recuperan movimiento de muñecas y dedos; los bajos exteriores acompañan
al pantalón. Falta publicar este candidato y verlo en sala desde dos conexiones.
La validación completa y la imagen oficial nueva ya están listas. El único
reintento autorizado del respaldo también falló: el supervisor aborta la copia
de medios al perder margen para cancelarla con seguridad. Los cinco servicios
están otra vez listos y no se ha desplegado. El propietario ha autorizado reparar
el respaldo y continuar: la corrección local pasa47 pruebas focales, pero quedan
comprobaciones completas antes de copiar y publicar. Seguimiento automático activo.
La aceptación visual no está cerrada.

La corrección del asiento y de locomoción `9f7c858ac` ya está desplegada tras
validación completa, imagen oficial y respaldo. Tu marcador sigue sin moverse.
El apoyo local coincide con la parte superior del triángulo azul, pero la prueba
con otro participante detectó una diferencia real en la chaqueta. Se ha localizado
y corregido en código: las copias de geometría compartían una marca de ajuste
sin compartir los vértices ajustados. Siete pruebas focales pasan. Falta publicar
esta corrección pequeña y repetir la aceptación con ambos participantes.

**Antecedente: correcciones desplegadas; aceptación visual reabierta.**
Actualización posterior: el propietario rechaza aún los movimientos de piernas
y brazos. Se ha localizado y corregido EN LOCAL una pérdida de rotación del
torso al adaptar las extremidades, además de la selección de dirección al girar.
Doce pruebas focales pasan, incluidas las cuatro marchas en ambos modelos reales.
Esta segunda corrección todavía NO está desplegada ni aceptada visualmente en sala.
El Mac ya permite navegador interno; no pedir de nuevo desbloqueo por el estado antiguo.

Antecedente del primer despliegue visual:
Se corrigió cómo la sala reconoce el esqueleto, la altura del avatar y el cruce
entre pantalón y chaqueta. Las dos sillas ya fijan su orientación. La nueva
versión está en el servidor y la comprobación operativa da cero fallos y avisos.
Las pruebas locales no sustituyen ver de cerca espalda, hombros, manos y asiento
en la sala. El bloqueo antiguo del Mac ya no aplica. No hay que recrear
avatares, volver a iniciar sesión ni repetir respaldo, build o despliegue.
Las PR de integración siguen en borrador hasta esa aceptación visual.

**Cierre anterior del 6 de septiembre (aceptación visual ahora reabierta):**
Dos avatares empresariales, masculino y femenino, están guardados como privados,
persisten y funcionan en sala. Se comprobaron sentarse, levantarse y la recepción
desde otra conexión. El editor ya tiene contraste corregido y funciona a tamaño
móvil 390x844 (prueba responsive, no teléfono físico). La clave antigua fue retirada.
La validación completa terminó correctamente y producción pasa con cero fallos
y cero avisos. Hubs8 y raíz30 ya están fusionadas con los punteros verificados.
El creador está disponible desde Cambiar avatar → Crear avatar. No hay cuota de
un proveedor de avatares ni infraestructura nueva. No repetir recuperación,
respaldo, compilación ni despliegue. Ampliar prendas queda para un encargo futuro.

Los párrafos siguientes son antecedentes; el estado vigente es el de arriba.

Estado anterior, ya superado en lo relativo al acceso:
Respaldo completo y 12 servicios listos. La comprobación productiva pasa con
0 fallos y 0 avisos. La nueva clave de correo funciona: Mailtrap confirma la
entrega del acceso a info@virtualmente.com. El navegador interno bloquea abrir
la vista de texto de ese enlace; debe abrirlo personalmente el propietario.
No hace falta otra clave. Después faltan guardado real, recarga, privacidad y
movimiento en sala, revocar la clave antigua y cerrar Git. No repetir respaldo,
compilación ni despliegue. El creador todavía no está aceptado por completo.

Antecedentes locales (las referencias a despliegue pendiente están superadas):
La revisión del
propietario detectó deformaciones de pecho/pie y una transición incorrecta al
levantarse. No basta con arreglar el polo. Se corregirá y demostrará en local
con ambas bases y ropa; SMTP solo bloquea el posterior despliegue, no este trabajo.
El rubio claro ya funciona en la muestra local: se aclaró la textura base sin
cambiar la forma ni la transparencia del pelo. Ya se han revisado los cinco
peinados claros y guardado una muestra femenina en la prueba local.
No se amplía todavía el catálogo.

Avance local: corregida la adaptación de orientación y de postura inicial de
los brazos. Ambos cuerpos completan tres ciclos de sentarse/levantarse sin
desplazamiento acumulado de cadera o torso. El femenino también se ha visto
caminando. Falta completar revisión de prendas y comprobarlo en la sala real;
estas pruebas locales no equivalen a un despliegue aceptado.

Las correcciones están publicadas en la rama de trabajo, commit `8c74e8c22`.
TypeScript y 131 pruebas pasan. La compilación oficial `33970705664`, Storybook
y seguridad han terminado correctamente; todavía no está desplegada.
Después faltan la creación persistente y el
uso en la sala real, con la renovación segura del correo previa al despliegue.

Estamos preparando un creador integrado: elegir un personaje, personalizar su
apariencia y guardarlo directamente como avatar privado. El objetivo está activo
y el trabajo se sigue en `PLAN_ACTUAL.md`. Primero se comprueban gratuidad,
licencias y un modelo real; después se implementa, prueba e integra.
No se ha desplegado todavía este creador. No se contratarán servicios ni se
creará infraestructura. La recuperación y los avatares privados ya probados no
se vuelven a abrir. Su plan anterior está conservado en
`OLD/docs/PLAN_ACTUAL-glb-completed-2026-09-03.md`.

El editor ya tiene cinco prendas superiores, cinco pantalones y cinco peinados
independientes, con ropa empresarial y casual de MakeHuman. La muestra con
americana, pantalón de lana y coleta se ha guardado correctamente en la prueba
local, con miniatura y privacidad. También se ha visto la segunda base corporal.
Se conservan los créditos de los autores en el creador y en el archivo exportado.
La prueba móvil local también permite personalizar y guardar. El código está
publicado en la rama de trabajo y la imagen oficial y CI han terminado bien.
Faltan integración final, despliegue
y comprobar movimiento y persistencia reales. No confundir el guardado local simulado con un avatar ya disponible
en producción. Antes del despliegue sigue pendiente la rotación segura de la
contraseña SMTP expuesta en una sesión anterior.

## Cierre anterior: avatares privados G2

**H5, Sitting v2 y la aceptación G2 de avatares privados están terminados e
integrados.** El registro de cierre está en
`OLD/docs/PLAN_ACTUAL-glb-completed-2026-09-03.md`; el de Sitting se ha guardado íntegro en
`OLD/docs/PLAN_ACTUAL-sitting-v2-completed-2026-08-30.md`.

El checkpoint completo previo está validado. El único fallo real era que
Reticulum no heredaba el grupo necesario para mover medios de la zona temporal
a `ret-pvc`; se corrigió en el manifiesto, se integró en `main=0857229` y se
desplegó por la ruta protegida sin cambiar imágenes, topología ni coste.
`CamisaNegra.glb` y `modelT.glb` ya están guardados como dos avatares privados,
se ven, caminan, corren y se sientan, y un observador aislado recibe su modelo,
movimiento y pose. El verificador live termina con **0 fallos y 0 avisos**.

No queda otra suite, checkpoint ni despliegue. `info@virtualmente.com` es la
cuenta A que creó los dos avatares. `info@meta-hubs.org` es el buzón receptor,
no el remitente: los enlaces salen de `noreply@meta-hubs.org`. Tras retirar de
Chrome la sesión antigua de A, un enlace nuevo creó e inició correctamente una
cuenta B normal y distinta. Su **Mis avatares** está vacío y no ofrece edición;
la base confirma que B no posee ninguno de los dos IDs y que A conserva ambos
activos, privados y sin listings.

**El fallo del selector ya está corregido e integrado en Hubs:** rechazar un archivo
nuevo permitía guardar el anterior por error. Se reprodujo y la corrección pasa
11 casos locales. El encuadre pasa otros ocho casos; la validación oficial
completa de Hubs terminó verde con 119 pruebas, cliente y Admin compilados.
La PR Hubs #7 pasó también seguridad y su build completo y quedó fusionada en
`master=668413a20`. El puntero raíz quedó integrado por la PR #22 en
`main=4f3d91a17`. El cliente Hubs no necesitó otra imagen durante la corrección
G2; solo cambió el contrato de montaje de Reticulum ya descrito.

**Ya tenemos los dos ejemplos: Avaturn y Mixamo.** Los he descargado yo de
ejemplos públicos, sin usar fotos tuyas ni crear cuentas. Ambos se ven en una
prueba local y tienen el esqueleto necesario. No necesitas adjuntar archivos.
Son muestras de prueba, no una contratación ni una integración de Avaturn.

**El bloque autónomo local también está terminado.** Se probó el editor real
con los dos modelos y se corrigió la cámara que mostraba solo un fragmento de
Mixamo. Ahora se ven los avatares completos y generan miniaturas. Los archivos
corruptos, demasiado grandes o sin esqueleto se rechazan. El guardado se simuló
solo en memoria: aquel bloque no lo demostraba por sí solo; G2 ya demostró
después persistencia, uso e aislamiento reales.

## Lo que quedó cerrado: recuperación

La recuperación ya ha terminado bien. YenHubs está activo otra vez con su base
de datos y sus medios originales. El verificador de producción terminó con
**0 fallos y 0 avisos**, y la batería local final pasó **894 de 894 pruebas**.
No hace falta repetir otro restore ni volver a crear DigitalOcean.

La recuperación, la aceptación humana y la integración están terminadas. El CI
final `33073636287` pasó PostgreSQL 12.19/14.23, gitlinks, Gitleaks, Actionlint,
ShellCheck y las **894/894** regresiones de recovery. La PR raíz #18 se fusionó
en `main` como `feee36b`; Cloud y los dos punteros exactos están integrados.
**H5 está cerrado y el proyecto puede volver a features.**

La revisión operativa posterior también está cerrada localmente. El único
`--full` adicional no descubrió una rotura del metaverso: mezcló timeouts bajo
carga monolítica con un rol PostgreSQL local incorrecto. Los casos exactos de
recuperación pasan por separado y el verificador ahora conserva recibos para no
repetir secciones verdes. No se ha tocado producción para hacer esta corrección.

El plan de H5 se ha guardado completo en `OLD/docs/` y ya no dirige trabajo.
La transición corta creó un worktree limpio y Sitting v2 se terminó después.
Los planes de ambas etapas están archivados; ninguno dirige trabajo nuevo.

## Lo que ya está demostrado

- PostgreSQL conserva las tablas y conteos esperados.
- El checkpoint previo a G2 conserva **33/33 pares de medios** y el estado live
  posterior contiene **39/39**: los anteriores más los seis pares de los dos
  avatares nuevos.
- Los cinco servicios escritores están activos y saludables; PostgreSQL está
  `1/1`.
- El lock de recuperación está ausente, la Lease está libre y no quedan
  helpers, policies ni procesos de restore.
- DNS, TLS, HTTPS, Namespace, PVC e imágenes coinciden con el bundle restaurado.
- El ghost runner histórico está activo y la sala `VJopCY3` muestra cinco bots.
- Navegador frío: Home y sala cargan en escritorio y móvil, en español, sin
  excepciones first-party; `APP`, `AFRAME`, escena y medios inicializan.
- Primera y tercera persona, sitting histórico, Admin y el proyecto Spoke
  `qa3U3Ke` con escena `f6VKtim` se han comprobado.
- El catálogo muestra nueve avatares con sus thumbnails.
- Se seleccionó realmente el avatar neutral `base` y la sala confirmó el cambio.
- El chat privado y temporal con `bot-2` respondió correctamente al mensaje
  inocuo autorizado.
- Dos participantes estuvieron presentes; el micrófono local registró voz, el
  propietario confirmó que el audio se oía en ambos sentidos y terminó otra vez
  silenciado.
- Las secciones finales pasan sin ejecutar otro `--full`: recuperación
  `894/894`, H5 `174/174`, HCCE, composición, advisories, static, security y
  Reticulum.
- El finalizador confirmó los dos gitlinks y todos los recibos exactos.
- Cloud quedó integrado en `6d9ee9e`; la raíz `main` contiene los gitlinks
  exactos de Hubs `ce8390a` y Cloud `6d9ee9e` mediante el merge `feee36b`.

## Qué falta para cerrar H5

Nada. La plataforma funciona, el CI final está verde y la integración raíz está
fusionada. No se repite el restore ni se vuelve a abrir H5 sin requisitos o
evidencia nuevos.

Las tres acciones que no debe fingir una prueba automática ya han pasado:
avatar real, chat privado y audio bidireccional con dos participantes.

## Lo que quedó cerrado: Sitting v2

**Sitting v2 ya está terminado y funcionando en producción.** Se desplegaron
exactamente las mismas imágenes que pasaron staging, primero Reticulum y después
Hubs. El clúster terminó con **12/12 servicios listos** y el verificador live
con **0 fallos y 0 avisos**.

En lenguaje humano, ya está demostrado todo el ciclo importante:

- dos personas intentan sentarse a la vez y solo una obtiene la silla;
- nunca aparecen dos concesiones privadas ni dos intervalos sentados solapados;
- ambos navegadores ven al ganador en la silla;
- al levantarse se libera, la otra persona puede ocuparla y el cierre abrupto
  también limpia la reserva;
- producción conserva la sala, la base de datos y los medios originales;
- el navegador frío carga en escritorio y móvil;
- en la sala real la silla quedó reservada, el avatar pasó a estado sentado,
  apareció el botón **Levantarse** y la pose se comprobó en tercera persona.

Antes de tocar producción se creó un checkpoint completo de base de datos y
medios, con checksums correctos. Sigue guardado en el área privada local como
rollback. No se cambió la topología de DigitalOcean ni se añadió coste mensual.

El staging ya se desmontó. La lectura final confirma ausencia del clúster, el
nodo, el balanceador, los dos discos y los dos firewalls exactos. Por tanto, el
**gasto adicional de staging está en cero** y DigitalOcean conserva únicamente
la topología productiva original.

En el cierre quedaron cuatro registros DNS de staging apuntando a la antigua IP
`178.128.139.203`. No generan coste de infraestructura, pero conviene retirarlos
porque una IP liberada puede reasignarse; no se garantiza su destino futuro. No
se borraron porque IONOS cerró la sesión y Google Password Manager pidió una
verificación física; no se forzó ni se cambió ninguna contraseña. Cuando IONOS
esté autenticado, se borran esos cuatro records exactos y se lee su ausencia.

El workspace es `/Users/Shared/Gits/YenHubs-features`. La implementación
se integró desde `codex/sitting-v2` y el cierre documental quedó fusionado en
la PR #21, `main` `34faabcc`, conservando los gitlinks exactos.
Los worktrees antiguos no se han limpiado, reutilizado ni borrado.

Hubs ya está integrado en `master` como `0781a6309` y Cloud como `db083d53`;
la raíz fija esos dos punteros. El CI raíz final `33286531422` terminó verde y
la PR #20 se fusionó en `main` como `032136ce`, con exactamente Hubs
`0781a63091ac3160a1b473504dc655ac0b002735` y Cloud
`db083d53e3d57c9380bbfefc6bd411e4d4bf4270`. Esta actualización documental es
el cierre terminal y no requiere repetir ninguna suite larga.

El residuo DNS es mantenimiento separado; no exige reabrir Sitting ni levantar
servidores. El acceso posterior a IONOS se limitó a los dos buzones autorizados
para la aceptación G2; no se modificaron DNS ni cuentas de correo.

## Lo que toca ahora: avatares GLB

La rama local es `codex/private-glb-acceptance`. Hay tres pasos prácticos:

1. **Preparación local cerrada:** selector 11/11 conservado; ocho pruebas
   nuevas de encuadre pasan. Avaturn y Mixamo se ven en el editor y producen
   miniaturas reales. Los tres archivos inválidos se rechazan. No equivale a
   guardado persistente, animación en sala ni prueba de un avatar de solo torso.
   Los resultados están [documentados](../features/avaturn/sample-check-2026-08-31.md).
2. **La sesión G2 ya ha creado exactamente dos avatares privados:**
   `CamisaNegra.glb` es `CRimmfo` y `modelT.glb` es `h2tMVFb`. Ambos pertenecen
   a la cuenta A, tienen promoción y remix desactivados, cero listings y seis
   pares físicos presentes. No aparecen en búsqueda ni Featured. Se cargan en
   la sala, animan y sincronizan movimiento y sentado/de pie con un observador.
3. **La cuenta B está aislada:** el buzón exacto `info@meta-hubs.org` recibió el
   enlace de `noreply@meta-hubs.org`. El primer intento falló porque Chrome aún
   estaba autenticado como A; tras cerrar A y pedir uno nuevo, B quedó creada
   como cuenta habilitada y no administradora. En su **Mis avatares** no aparece
   ninguna ficha ni control de edición. El readback confirma tres cuentas
   habilitadas, cero avatares objetivo para B, propietario A intacto y cero
   listings. No queda otro rollout, test largo, checkpoint, recurso, coste ni
   borrado.

Los cambios se fusionaron desde `codex/private-glb-selection`: candidata
`e83adaf38`, merge Hubs `668413a20`, raíz `4f3d91a17`. La sección oficial y el
CI Hubs están verdes. En la PR raíz pasaron gitlinks, secretos, workflows,
scripts y PostgreSQL; se canceló cuando empezó a repetir recovery histórico,
que este plan prohíbe. El build `33504152150` produjo el digest
`sha256:04544546…f672f`; el checkpoint conservó 361 tablas, 100 migraciones,
18 salas y 33/33 pares de medios. El primer apply detectó una marca temporal
heredada de Reticulum y se cerró con seguridad; se corrigió solo esa causa y el
reintento terminó verde. La corrección permanente está en Cloud
`master=43210079d`. La corrección G2 posterior de escritura en `ret-pvc` quedó
en Cloud `cc52a184` y raíz `main=0857229`; no cambió la imagen Hubs.

El navegador interno cargó el bundle nuevo en escritorio y móvil 390×844,
sin errores ni desbordamiento; solo aparece el warning `background` ya conocido.
La comprobación final entró de verdad en la sala con el micrófono silenciado y
sin vídeo: `APP`, `AFRAME`, la escena, el renderizador, sus 22 sistemas, el
canvas y el avatar quedaron activos; la UI mostró `Personas (1)` y no hubo
errores. Aquella pasada no abrió el selector; G2 sí lo abrió después y guardó
los dos avatares descritos arriba. No queda un proceso local de verificación
consumiendo CPU.

**“Privado” quiere decir no listado en el catálogo**, no archivo secreto ni
cifrado. Otras personas deben poder verlo cuando lo llevas puesto en la sala.
No vamos a integrar un proveedor de pago, crear staging ni añadir coste fijo.
Los ejemplos se quedan locales: que sean públicos no permite automáticamente
repartirlos a clientes. Las condiciones comerciales de Avaturn siguen siendo
una decisión separada; no bloquean conseguir ni inspeccionar las muestras.

## Qué no se va a hacer

- No habrá otro restore, recreación de staging ni repetición del rollout S5.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se repetirá el `--full` posterior: sus fallos ya tienen diagnóstico y
  focales exactas verdes.
- No se compartirán ingress, namespaces globales, datos ni credenciales con
  producción para ahorrar unos céntimos.

## Cuánto queda

**0 % de H5 pendiente.** Validación, recuperación, producción, aceptación
humana, CI, gitlinks y merge están resueltos.

**0 % de Sitting v2 pendiente.** Fuente, pruebas locales, builds, staging real,
E2E multiusuario, checkpoint, rollout productivo y aceptación visual están
terminados. El cleanup de cuatro DNS sin coste es mantenimiento menor, no parte
de la feature ni otro proyecto.

**GLB: 100 % funcional, aceptado e integrado.** Código, checkpoint, corrección, rollout,
los dos guardados privados, readback, catálogo, uso en sala, observador remoto,
carga fría, verificador live y aislamiento con B están terminados. La PR raíz
#28 integró el cierre documental en `main=28dddf7`; no hay otra batería larga ni
otra intervención en DigitalOcean.

## Cuándo se para

No se pide supervisión ni confirmaciones repetidas dentro del G2 ya autorizado.
Se devuelve el control al cerrar el objetivo o solo si aparece una credencial
imprescindible inaccesible, una identidad distinta, una pérdida de estado seguro,
un cambio real de datos/destino/riesgo/coste o un fallo grave nuevo sin causa
demostrable. Un fallo normal se corrige por su causa sin abrir otro proyecto.
