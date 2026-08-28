# Estado sencillo de YenHubs

Ultima actualización: **28 de agosto de 2026**

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
El nuevo `PLAN_ACTUAL.md` abre una transición corta: preparar un worktree limpio,
corregir estados documentales obsoletos y elegir una sola feature.

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

1. Crear un worktree local limpio para features, sin limpiar ni reutilizar el
   checkout histórico.
2. Corregir solo los estados obsoletos que podrían repetir merges o gates ya
   cerrados.
3. Elegir una única primera feature: **Sitting v2** —recomendada— o **GLB
   neutral** como alternativa visible más pequeña.
4. Abrir después un plan específico solo para la elegida.

El hardening operativo nuevo está en una rama local. Publicarlo más adelante
no es requisito para que el metaverso actual funcione ni para empezar features.

## Qué no se va a hacer

- No habrá otro restore, checkpoint, clúster ni copia nueva.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se repetirá el `--full` posterior: sus fallos ya tienen diagnóstico y
  focales exactas verdes.
- No se tocarán costes, topología o secretos para cerrar esta fase.

## Cuánto queda

**0 % de H5 pendiente.** Validación, recuperación, producción, aceptación
humana, CI, gitlinks y merge están resueltos.

La nueva fase de features todavía no tiene porcentaje: primero debe elegirse
una única feature. La preparación del workspace y la reconciliación documental
son dos bloques finitos y no reabren H5.

## Cuándo se para

Solo ante una identidad distinta, lock/Lease ambiguos, pérdida del estado
seguro, exposición de un secreto, un cambio de coste/topología no previsto o un
fallo grave que necesite investigación superior. Un fallo normal no abre otro
proyecto: se corrige únicamente su causa demostrada.
