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
  Editor local móvil 390x844 verificado: controles, preview y guardado privado
  simulado pasan en ambas bases; falta uso/pose/remoto en la sala real.
  Diez renders verifican jersey con cada pantalón y ambas bases tras corregir
  intersecciones en cintura. Flexión artificial de piernas en visor demuestra
  que las prendas siguen al rig, NO acredita el protocolo Sitting de una sala.
- [ ] Seguridad final, commit, publicación e imagen oficial.
  Commit Hubs local 3987f8b6acce3aedb32fd3bf454dbdf9530df686, árbol limpio.
  Gitleaks (assets y staged), Actionlint y diff-check pasan. Build de producción
  local correcto con dos avisos de tamaño. Rama Hubs publicada; security-ci
  33928843627 verde. Imagen oficial única 33928876505 sobre 3987f8b6 en curso;
  test-and-deploy-storybook 33928843616 en curso. No relanzar ni duplicar.
  Reentrada: consultar esos IDs; si fallan, examinar solo el diagnóstico nuevo.
  Documentación raíz guardada localmente en 2e49aa4, aún sin publicar.
- [ ] Despliegue protegido y aceptación productiva.
  Antes del rollout: rotación segura de SMTP_PASS por exposición histórica,
  checkpoint DB+medios, imagen/digest y manifest generado. Después, creación,
  recarga, privacidad y uso/pose/remoto en sala con navegador interno.
  No imprimir valores, no crear infraestructura, no repetir recovery ni H5.
  Mailtrap mantiene sesión interna; formulario Add API Token abierto sin guardar
  (settings/api-tokens/new). No se ha creado ni revocado ningún token. Requiere
  intervención del propietario para la credencial nueva; conservar la antigua
  hasta sustituirla por la ruta protegida y comprobar envío, después revocarla.
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
