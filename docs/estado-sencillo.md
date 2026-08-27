# Estado sencillo de YenHubs

Ultima actualización: **27 de agosto de 2026**

## Respuesta corta

La recuperación ya ha terminado bien. YenHubs está activo otra vez con su base
de datos y sus medios originales. El verificador de producción terminó con
**0 fallos y 0 avisos**, y la batería local final pasó **894 de 894 pruebas**.
No hace falta repetir otro restore ni volver a crear DigitalOcean.

La recuperación y la aceptación humana están terminadas. Falta únicamente
fusionar el código raíz. Cloud ya está integrado y el PR #18 sigue abierto. El
último examen de GitHub dejó verdes PostgreSQL y el resto de seguridad, pero
falló solo el positivo que combinaba tres monitores y un dump detenido de forma
artificial. La causa ya está corregida localmente: pasan el positivo **47/47**,
la coordinación **50/50**, los abortos seguros **63/63**, ShellCheck, gitlinks y
Gitleaks. El primer CI del candidato encontró siete incompatibilidades en otras
pruebas del mismo supervisor: una reserva nueva agotaba por sí sola la ventana
más corta y habían cambiado nombres diagnósticos estables. Se corrigió sin
ampliar ningún plazo y los focos exactos pasan **92/92** y **53/53**. Este último
ajuste todavía no se ha subido ni cuenta como CI verde.

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
- Cloud quedó integrado en `6d9ee9e`; el PR raíz #18 contiene el gitlink y el
  cierre H5, pero todavía no está fusionado en `main`.

## Qué falta para cerrar H5

La plataforma restaurada ya funciona y no necesita otra intervención. El
cambio local elimina comprobaciones completas repetidas dentro del mismo ciclo
y separa dos responsabilidades de prueba que estaban duplicadas. Las
regresiones dirigidas y el análisis estático ya están verdes, incluidos los
siete casos que encontró GitHub. Falta subir el commit correctivo, obtener un
único examen verde y fusionar #18. No se repite el restore, no se toca
DigitalOcean y no se vuelven a ejecutar los bloques ya aceptados.

Las tres acciones que no debe fingir una prueba automática ya han pasado:
avatar real, chat privado y audio bidireccional con dos participantes.

## Lo que toca ahora

1. Publicar el candidato local ya validado.
2. Obtener un único CI verde de #18 y fusionarlo.
3. Volver a desarrollar features.
4. Mantener este recovery como capacidad operativa, sin reabrir H5 salvo que
   cambien sus requisitos o aparezca evidencia nueva.

## Qué no se va a hacer

- No habrá otro restore, checkpoint, clúster ni copia nueva.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se tocarán costes, topología o secretos para cerrar esta fase.

## Cuánto queda

Queda el cierre técnico: un commit, un CI verde y merge de #18. La validación
local, recuperación, producción, aceptación humana y recibos ya están resueltos.

## Cuándo se para

Solo ante una identidad distinta, lock/Lease ambiguos, pérdida del estado
seguro, exposición de un secreto, un cambio de coste/topología no previsto o un
fallo grave que necesite investigación superior. Un fallo normal no abre otro
proyecto: se corrige únicamente su causa demostrada.
