# Evaluación de proveedores de avatares — julio de 2026

## Decisión

YenHubs no debe sustituir Ready Player Me por otra dependencia embebida de
forma automática en este ciclo. La vía de producción recomendada es el flujo
neutral **GLB privado/no listado**, ya existente y alojado en la propia
instancia. Como siguiente piloto, MPFB/MakeHuman permite generar avatares de
forma local sin transferir fotografías a un tercero. Avaturn y MetaPerson solo
deben habilitarse tras una aprobación contractual, de privacidad y de coste.

La subida manual de GLB, incluida la de avatares RPM ya descargados, se
mantiene. No se ha creado ninguna cuenta, suscripción ni recurso de pago como
resultado de esta evaluación.

## Estado comprobado

| Opción | Estado y encaje técnico | Coste público observado | Riesgos y decisión |
| --- | --- | --- | --- |
| Ready Player Me | El proveedor discontinuó sus servicios el 31-01-2026; su portada actual confirma el cierre. Los GLB ya exportados siguen siendo archivos utilizables. | No aplicable como servicio futuro. | **No-go como dependencia.** Conservar importación manual de GLB y la compatibilidad Mixamo; no mantener iframe/API. |
| Avaturn | SDK web en iframe con callback de exportación GLB; integración sencilla con el flujo actual. La documentación oficial vigente afirma que la integración básica es gratuita, sin límite de avatares ni exportaciones, y que el resultado se genera como GLB. | Básico: anunciado como gratuito y sin límite de exportaciones. Pro: USD 800/mes, hasta 1.000 avatares/mes y USD 0,15 por avatar adicional; Enterprise a medida. Algunas funciones requieren plan de pago. | **Hold.** Sí existe hoy una vía oficial de exportación GLB gratuita, pero eso no resuelve el encaje comercial: sus términos públicos exigen atribución y restringen el uso para terceros sin Enterprise. La política pública cubre fotos, vídeo/TrueDepth, nube y mejora tecnológica. Requiere confirmación escrita de licencia, DPA/transferencias, retención, menores, borrado y SLA. |
| MetaPerson Creator | Producto activo, cuerpo completo, integración web/JS y exportación GLB/GLTF/FBX con LOD, texturas, esqueleto, animaciones y visemas configurables; REST API solo Enterprise. La versión Desktop 1.35.0 figura con fecha 25-06-2026. | No hay una tarifa pública completa verificable. La cuenta abre un trial de Pro; la documentación advierte que Export puede quedar inactivo sin Pro o superior, y las notas mencionan coins/precios de assets sin publicar aquí una equivalencia por avatar. REST API: Enterprise a medida. | **Hold.** Técnicamente viable, pero exige cuenta/credenciales y revisión de coste por exportación/assets, contrato, privacidad biométrica/fotográfica, DPA, exportación y continuidad. |
| MPFB / MakeHuman | Generación local en Blender/MakeHuman; salida exportable y controlable antes de subirla. Los assets base son CC0; MPFB es GPL y MakeHuman AGPL. | Sin tasa de licencia del proyecto. Coste operativo: preparación, rig, optimización y QA. | **Piloto recomendado.** Minimiza dependencia y transferencia de imágenes. Validar rig Mixamo/Hubs, materiales, LOD, visemas, animaciones, móvil y procedencia de assets adicionales. |
| GLB propio o de otro proveedor | El cliente ya valida GLB 2.0, tamaño y esqueleto, genera preview y guarda el avatar sin listarlo. | Sin nueva suscripción; usa el almacenamiento existente. | **Ruta de producción.** “Privado” significa no listado, no cifrado extremo a extremo: el fichero sigue sujeto a permisos, administradores y backups de YenHubs. |

### Matriz técnica y nivel de evidencia

| Opción | Formato y rig documentados | Facial | Integración posible | Dependencia | Evidencia real en YenHubs |
| --- | --- | --- | --- | --- | --- |
| Ready Player Me exportado | GLB full-body; YenHubs reconoce huesos `mixamorig`/`wolf3d` y conserva retargeting Mixamo. | Depende del GLB ya exportado. | Solo carga manual; no se conserva iframe/API. | Ninguna para un fichero ya descargado; el servicio creador está cerrado. | **Probado históricamente** con los RPM existentes en locomoción, primera/tercera persona y sitting; cada nuevo fichero sigue requiriendo validación. |
| Avaturn | GLB; T1/T2 y cuerpos v2023/v2024. T1 no tiene bones/blendshapes faciales; T2 ofrece ARKit y visemas. La documentación publica flujo Mixamo, pero no identidad exacta con el rig de YenHubs. | Ninguno en T1; ARKit/visemas en T2. | Iframe/SDK/callback o exportación y carga manual. | Nube, cuenta/proyecto y términos del proveedor para crear/exportar. | **Solo documental.** Ningún GLB Avaturn actual ha pasado el gate YenHubs. |
| MetaPerson | GLB/GLTF/FBX, LOD y texturas configurables; cuerpo completo, rig declarado compatible con Mixamo, animaciones y visemas/blendshapes. | Visemas, ARKit/blendshapes y animaciones según export/template. | Iframe/JS con credenciales, REST Enterprise o carga manual de GLB. | Nube, cuenta/Pro o Enterprise y assets/coins. | **Solo documental.** “Técnicamente viable” significa candidato a ensayo, no compatibilidad demostrada. |
| MPFB / MakeHuman | Exportación local mediante Blender; rigs Rigify/Mixamo disponibles y assets base CC0. La calidad de weight painting y assets adicionales varía. | No existe un contrato facial/visemas uniforme para todo output. | Generación offline y carga manual. | Sin servicio externo; depende de Blender/MPFB y del inventario local de assets. | **No probado aún** con un GLB piloto reciente en YenHubs. |
| GLB genérico | GLB 2.0; YenHubs exige esqueleto upper-body y detecta full-body/Mixamo cuando existe. | Solo las morphs/bones que aporte el fichero. | Carga manual privada/no listada. | Ningún proveedor obligatorio; almacenamiento propio. | **Contrato probado**, pero la compatibilidad visual/animación se acepta fichero por fichero. |

“Solo documental” no autoriza rollout. Para declarar compatible un sustituto se
necesita un GLB reciente que pase preview/guardado y la matriz de primera y
tercera persona, idle/walk/run, sitting/standing, manos/materiales, remoto,
memoria/FPS y móvil descrita más abajo.

Fuentes oficiales consultadas el 17-07-2026:

- [portada de Ready Player Me que confirma la discontinuación](https://readyplayer.me/?welcome=true) y [anuncio previo del cierre](https://forum.readyplayer.me/t/an-important-update-from-ready-player-me/3706);
- [precios de Avaturn](https://avaturn.dev/pricing/), [inicio gratuito sin límite declarado de avatares/exportaciones](https://docs.avaturn.me/), [SDK web y exportación GLB](https://docs.avaturn.me/docs/integration/web/html/), [términos](https://docs.google.com/document/d/e/2PACX-1vT5_TR6-MNs29LqI-LLKHvIKHVE0iluuapOpHODGRVDaqyfuCsEgaiE3ZIliI1-FN_-9rxJZ3iVo_jJ/pub) y [privacidad](https://docs.google.com/document/d/e/2PACX-1vT-lYthxjPO4SbgkB2kJN8dTFWvRVdF3srOs37oRBgL7IYXK0PAD62u-tF8JXo8ULV6_KVfRW_kuIMo/pub);
- [tipos T1/T2 y rigs v2023/v2024 de Avaturn](https://docs.avaturn.me/docs/integration/bodies/) y [uso con Mixamo](https://docs.avaturn.me/docs/importing/mixamo/);
- [MetaPerson Creator](https://docs.metaperson.avatarsdk.com/), [cuenta y trial Pro](https://docs.metaperson.avatarsdk.com/getting_started/), [integración web y requisito Pro para exportar](https://docs.metaperson.avatarsdk.com/web_integration/), [formatos y rig/exportación](https://docs.metaperson.avatarsdk.com/js_api/), [REST API Enterprise](https://docs.metaperson.avatarsdk.com/rest_api/) y [notas de versión Desktop](https://docs.metaperson.avatarsdk.com/business-integration/release_notes/desktop/);
- [rig Mixamo-compatible de MetaPerson](https://docs.metaperson.avatarsdk.com/business-integration/ue/);
- [licencia MakeHuman/MPFB](https://static.makehumancommunity.org/about/license.html) y [FAQ de MPFB](https://static.makehumancommunity.org/mpfb/faq/is_it_really_free.html).

Esto es una evaluación técnica y de riesgo, no asesoramiento jurídico. Los
términos y precios deben comprobarse otra vez antes de contratar.

La cautela con Avaturn es material, no hipotética. Los términos y la política
de privacidad enlazados desde su propia página de precios figuran como
actualizados por última vez el 26-01-2023. Los términos atribuyen al proveedor
la propiedad intelectual del avatar/servicio y describen una licencia
revocable, además de exigir Enterprise cuando la integración beneficia a
terceros. La política permite conservar vídeo anonimizado y otros datos
durante el tiempo necesario para sus fines y todavía invoca el antiguo
Privacy Shield para transferencias. Por tanto, esas páginas no demuestran por
sí solas una base contractual y de transferencia vigente para YenHubs; se
necesita confirmación escrita y revisión jurídica antes de cualquier piloto
con usuarios reales.

## Contrato neutral de YenHubs

El límite estable de la integración es un fichero GLB y no una API de
proveedor:

1. El usuario obtiene el GLB fuera de YenHubs o lo genera localmente.
2. YenHubs acepta solo GLB 2.0 dentro del límite de 64 MiB.
3. El cliente carga y previsualiza el modelo antes de permitir guardarlo.
4. Se verifica un esqueleto upper-body compatible y se conserva la detección
   full-body/Mixamo para locomoción, tercera persona y sentado.
5. Reticulum almacena los artefactos mediante el flujo normal de media/avatar.
6. `allow_promotion=false` y `allow_remixing=false`; no se crea un
   `avatar_listing`.
7. El avatar aparece únicamente en `Mis avatares` de su propietario.

No se debe almacenar la foto original, el vídeo, credenciales del proveedor,
tokens de exportación ni telemetría de su editor. Si en el futuro se aprueba un
proveedor embebido, su adaptador debe terminar en este mismo contrato y quedar
detrás de una feature flag desactivada por defecto.

## Puertas para un proveedor embebido futuro

Antes de escribir o activar un adaptador externo se necesitan todas estas
evidencias:

- autorización escrita para el modelo comercial real de YenHubs y sus
  clientes, incluida propiedad/licencia de cada GLB y assets incorporados;
- precio, límites, sobrecostes, SLA, exportación y terminación sin cautividad;
- DPA, ubicaciones/subencargados, base jurídica, transferencias, retención,
  borrado, menores y tratamiento de foto/vídeo/datos biométricos;
- consentimiento explícito y aviso antes de abrir cámara o subir una foto;
- CSP y allowlist de dominios mínimos, iframe aislado, mensajes validados por
  origen y sin tokens persistentes en el navegador;
- descarga server-side con límite de bytes, timeout, redirects revalidados,
  tipo/contenido GLB comprobado y sin SSRF;
- feature flag, métricas sin contenido personal, rate limit, presupuesto y
  kill switch;
- prueba de salida: los GLB ya creados continúan funcionando tras desactivar el
  proveedor.

## Aceptación del piloto MPFB/MakeHuman

El piloto es offline y no cambia producción. Debe usar un avatar de prueba sin
datos reales y demostrar:

- GLB 2.0 por debajo de 64 MiB, sin recursos externos ni extensiones no
  permitidas;
- preview, thumbnail, guardado no listado y selección desde `Mis avatares`;
- esqueleto, escala, orientación, materiales y manos correctos;
- primera y tercera persona, idle/walk/run, sitting/standing y sincronización
  remota sin regresiones;
- FPS y memoria aceptables en escritorio y móvil con varios avatares;
- inventario de licencias de ropa, pelo, texturas y animaciones adicionales;
- borrado/restauración mediante el ciclo normal de DB más `ret-pvc`.

## Rollout y rollback

El cambio candidato solo renombra la UI de “Avaturn” a “GLB privado” y elimina
el enlace promocional a un proveedor. No altera el contrato de almacenamiento.
Se conserva temporalmente el nombre interno de evento/modo anterior como alias
de compatibilidad. El rollback consiste en revertir el commit del cliente; los
avatares existentes y sus registros no se modifican. Esta evaluación no prueba
que el cambio esté desplegado: ese estado requiere Actions, imagen por digest y
aceptación cold-browser de escritorio y móvil.
