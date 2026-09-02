# Estado sencillo de YenHubs

Ultima actualización: **1 de septiembre de 2026**

## Respuesta corta

**H5 y Sitting v2 están terminados. El nuevo trabajo es comprobar la carga
privada de avatares GLB que ya existe, no reconstruirla.** El plan activo está en
[`PLAN_ACTUAL.md`](../PLAN_ACTUAL.md); el de Sitting se ha guardado íntegro en
`OLD/docs/PLAN_ACTUAL-sitting-v2-completed-2026-08-30.md`.

Ya se contrastaron código, build e historial del despliegue: la interfaz neutral
estaba incluida. Falta probar con archivos reales que se previsualizan, se
guardan solo en Mis avatares del propietario y funcionan en la sala. No se ha
subido ni guardado nada en esta revisión. No hay un `--full`, build ni otra
espera de GitHub en marcha por este plan.

**El fallo del selector ya está corregido e integrado en Hubs:** rechazar un archivo
nuevo permitía guardar el anterior por error. Se reprodujo y la corrección pasa
11 casos locales. El encuadre pasa otros ocho casos; la validación oficial
completa de Hubs terminó verde con 119 pruebas, cliente y Admin compilados.
La PR Hubs #7 pasó también seguridad y su build completo y quedó fusionada en
`master=668413a20`. El puntero raíz quedó integrado por la PR #22 en
`main=4f3d91a17`; no se ha cambiado el metaverso live.

**Ya tenemos los dos ejemplos: Avaturn y Mixamo.** Los he descargado yo de
ejemplos públicos, sin usar fotos tuyas ni crear cuentas. Ambos se ven en una
prueba local y tienen el esqueleto necesario. No necesitas adjuntar archivos.
Son muestras de prueba, no una contratación ni una integración de Avaturn.

**El bloque autónomo local también está terminado.** Se probó el editor real
con los dos modelos y se corrigió la cámara que mostraba solo un fragmento de
Mixamo. Ahora se ven los avatares completos y generan miniaturas. Los archivos
corruptos, demasiado grandes o sin esqueleto se rechazan. El guardado se simuló
solo en memoria: esto no demuestra todavía persistencia ni privacidad real.

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
- Los **33/33 pares de medios** están presentes.
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
servidores. No se ha accedido a IONOS para este nuevo trabajo.

## Lo que toca ahora: avatares GLB

La rama local es `codex/private-glb-acceptance`. Hay tres pasos prácticos:

1. **Preparación local cerrada:** selector 11/11 conservado; ocho pruebas
   nuevas de encuadre pasan. Avaturn y Mixamo se ven en el editor y producen
   miniaturas reales. Los tres archivos inválidos se rechazan. No equivale a
   guardado persistente, animación en sala ni prueba de un avatar de solo torso.
   Los resultados están [documentados](../features/avaturn/sample-check-2026-08-31.md).
2. **La sesión G2 está concretada y autorizada, pero aún no ha escrito:** producción
   `meta-hubs.org`, las dos cuentas existentes y dos archivos recuperados del
   propio proyecto —uno Ready Player Me y otro Avaturn/Blender—. No se usarán
   las muestras públicas descargadas. Antes de guardar se hará un único
   checkpoint DB + medios; después se crearán como máximo dos avatares privados,
   se comprobarán con ambas cuentas y se verán en movimiento/pose. La
   confirmación inmediata para el checkpoint, los magic links estrictamente
   necesarios y los dos uploads exactos ya está recibida.
3. **Rollout terminado:** la imagen oficial de Hubs `668413a20` está
   desplegada por digest en la instancia existente. Se creó antes un checkpoint
   completo DB + medios; después quedaron 12/12 servicios listos, diff cero y
   el verificador live dio **0 fallos / 0 avisos**. No se crearon recursos ni se
   subieron las muestras.

Los cambios se fusionaron desde `codex/private-glb-selection`: candidata
`e83adaf38`, merge Hubs `668413a20`, raíz `4f3d91a17`. La sección oficial y el
CI Hubs están verdes. En la PR raíz pasaron gitlinks, secretos, workflows,
scripts y PostgreSQL; se canceló cuando empezó a repetir recovery histórico,
que este plan prohíbe. El build `33504152150` produjo el digest
`sha256:04544546…f672f`; el checkpoint conservó 361 tablas, 100 migraciones,
18 salas y 33/33 pares de medios. El primer apply detectó una marca temporal
heredada de Reticulum y se cerró con seguridad; se corrigió solo esa causa y el
reintento terminó verde. La corrección permanente está en Cloud
`master=43210079d`.

El navegador interno cargó el bundle nuevo en escritorio y móvil 390×844,
sin errores ni desbordamiento; solo aparece el warning `background` ya conocido.
La comprobación final entró de verdad en la sala con el micrófono silenciado y
sin vídeo: `APP`, `AFRAME`, la escena, el renderizador, sus 22 sistemas, el
canvas y el avatar quedaron activos; la UI mostró `Personas (1)` y no hubo
errores. La pestaña se cerró al terminar. No se abrió el selector ni se guardó
un GLB: eso sigue siendo la aceptación persistente posterior, no parte del
rollout ya cerrado. No queda un proceso local consumiendo CPU.

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

**GLB: código y rollout terminados; aceptación persistente pendiente.** Los
archivos ya están conseguidos y el candidato está operativo. Falta una sesión
separada para guardar como máximo dos avatares con permiso, comprobar dos
cuentas y su uso visible en sala. No son otras siete suites largas ni se repite
lo que ya pasó. No doy un porcentaje que mezcle rollout cerrado con escrituras
que todavía no se han autorizado de forma concreta.

## Cuándo se para

No se pide supervisión entre comprobaciones locales. Se devuelve el control al
cerrar el objetivo acotado o cuando haga falta una decisión real: autorización
de publicación/producción, cuenta/licencia, identidad distinta, secreto expuesto
o efecto no previsto. Un fallo normal se corrige por su causa sin abrir otro
proyecto. Crear un Goal no autoriza automáticamente todas las fases posteriores.
