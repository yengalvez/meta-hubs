# Estado sencillo de YenHubs

Ultima actualización: **30 de agosto de 2026**

## Respuesta corta

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
La transición corta ya creó un worktree limpio y corrigió los estados
documentales obsoletos. Se eligió **Sitting v2** y el nuevo `PLAN_ACTUAL.md`
dirige exclusivamente esa feature.

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

## Lo que toca ahora

Sitting v2 ya ha pasado el staging real. Se publicó una escena desechable en
Spoke, se promovieron Reticulum y Hubs por sus digests fijados y el clúster
terminó con **12/12 servicios listos**. La prueba final abrió dos navegadores
aislados y terminó **1/1 verde en 47,1 segundos**.

En lenguaje humano, la prueba confirmó todo el ciclo importante:

- dos personas intentan sentarse a la vez y solo una obtiene la silla;
- nunca aparecen dos concesiones privadas ni dos intervalos sentados solapados;
- ambos navegadores ven al ganador en la silla;
- al levantarse se libera, la otra persona puede ocuparla y el cierre abrupto
  también limpia la reserva;
- no quedaron errores inesperados de navegador o red.

La captura automática existe, pero la cámara no encuadró al avatar remoto. Los
estados y posiciones sí demostraron la pose; la apariencia/intersecciones deben
mirarse una vez en el navegador frío de producción antes de declarar la feature
comercialmente cerrada.

El staging ya se desmontó. La lectura final confirma ausencia del clúster, el
nodo, el balanceador, los dos discos y los dos firewalls exactos. Por tanto, el
**gasto adicional de staging está en cero** y DigitalOcean conserva únicamente
la topología productiva original.

Quedan cuatro registros DNS de staging apuntando a la antigua IP
`178.128.139.203`. No generan coste ni mantienen ningún servidor accesible. No
se borraron porque IONOS cerró la sesión y Google Password Manager pidió una
verificación física; no se forzó ni se cambió ninguna contraseña. Cuando IONOS
esté autenticado, se borran esos cuatro records exactos y se lee su ausencia.

El siguiente bloque real es S5: checkpoint DB+medios, revisión del diff,
Reticulum primero, Hubs después, reinicio de Reticulum y aceptación fría. Es
producción y necesita una autorización separada; no se ha iniciado ni tocado.

El workspace nuevo es `/Users/Shared/Gits/YenHubs-features`, está en la rama
local `codex/sitting-v2` y conserva los gitlinks exactos. Los worktrees
antiguos no se han limpiado, reutilizado ni borrado.

El código autoritativo ya existe en Hubs y Reticulum. Producción conserva los
commits anteriores y solo demuestra sitting histórico; la carrera v2 todavía
necesita build, staging y aceptación antes de cualquier promoción.

El hardening operativo nuevo está en una rama local. Publicarlo más adelante
no es requisito para que el metaverso actual funcione ni para empezar features.

## Qué no se va a hacer

- No habrá otro restore ni recreación de staging. S5 sí exige un checkpoint
  nuevo DB+medios antes de modificar producción.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se repetirá el `--full` posterior: sus fallos ya tienen diagnóstico y
  focales exactas verdes.
- No se compartirán ingress, namespaces globales, datos ni credenciales con
  producción para ahorrar unos céntimos.

## Cuánto queda

**0 % de H5 pendiente.** Validación, recuperación, producción, aceptación
humana, CI, gitlinks y merge están resueltos.

La preparación y aceptación de Sitting v2 fuera de producción están
**terminadas**: fuente, pruebas locales, builds, staging real y E2E. Como
estimación humana, la feature completa está alrededor del **80 %**: falta el
rollout productivo S5, su navegador frío y la comprobación visual final. El
cleanup de cuatro DNS sin coste es una tarea operativa menor, no otro proyecto.

## Cuándo se para

Solo ante una identidad distinta, lock/Lease ambiguos, pérdida del estado
seguro, exposición de un secreto, un cambio de coste/topología no previsto o un
fallo grave que necesite investigación superior. Un fallo normal no abre otro
proyecto: se corrige únicamente su causa demostrada.
