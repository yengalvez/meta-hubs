# Implementación de Avaturn en Mozilla Hubs
## Guía Rápida de Inicio

Esta documentación proporciona todo lo necesario para implementar el sistema de avatares de **Avaturn** en **Mozilla Hubs** (hubs-foundation), usando como referencia las implementaciones de ReadyPlayer.me y BELIVVR XRcloud.

---

## 📚 Contenido

```
📦 Avaturn/
├── 📄 README.md                                    # ← Estás aquí - Guía rápida
├── 📘 IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md      # Documentación completa (12,000+ líneas)
└── 💾 codigo/
    ├── avatar-validator.js                        # Validador y procesador de avatares
    └── avaturn-integration-example.html           # Ejemplo HTML listo para usar
```

---

## 🚀 Inicio Rápido (5 minutos)

### Opción 1: Probar el Ejemplo HTML

**La forma más rápida de ver Avaturn funcionando:**

1. **Abrir el archivo de ejemplo:**
   ```bash
   # Navega a la carpeta
   cd codigo/

   # Abrir en navegador
   open avaturn-integration-example.html
   # O doble click en el archivo
   ```

2. **Usar el creador:**
   - El iFrame de Avaturn se carga automáticamente
   - Crea un avatar usando selfie o webcam
   - Haz clic en "Next" cuando termines
   - El avatar se exporta automáticamente

3. **Resultado:**
   - Ver datos del avatar (ID, body type, etc.)
   - Descargar GLB
   - Obtener URL para usar en Hubs

**¡Listo!** Ya tienes un avatar de Avaturn exportado.

---

### Opción 2: URL Parameters en Hubs

**Usar avatar de Avaturn sin modificar código de Hubs:**

1. **Crear avatar en Avaturn:**
   - Ir a https://demo.avaturn.dev/
   - Crear y exportar avatar
   - Copiar URL del GLB

2. **Usar en Hubs:**
   ```
   https://hubs.mozilla.com/room-id?avatarUrl=TU_URL_GLB_AQUI
   ```

**Ventajas:**
- ✅ Sin modificaciones de código
- ✅ Funciona inmediatamente
- ✅ Gratis

**Desventajas:**
- ❌ Requiere URL pública del GLB
- ❌ No integrado en el editor de Hubs

---

## 📖 Documentación Completa

Para implementación completa en el código de Hubs, consulta:

**`IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md`**

Este documento de 12,000+ líneas incluye:

1. ✅ Estado actual de Mozilla Hubs (hubs-foundation)
2. ✅ Arquitectura completa del sistema de avatares
3. ✅ Implementación de ReadyPlayer.me (código, issues, soluciones)
4. ✅ Sistema BELIVVR XRcloud (avatares personalizados)
5. ✅ Documentación de Avaturn (modo gratuito sin API)
6. ✅ **3 estrategias de implementación** (URL, iFrame, SDK)
7. ✅ **Código completo** listo para copiar
8. ✅ **Problemas conocidos y soluciones**
9. ✅ Testing y validación
10. ✅ Referencias y recursos

---

## 🎯 Opciones de Implementación

### A. URL Parameters (Complejidad: 🟢 Baja)

**Sin modificar código de Hubs.**

```
https://hubs.mozilla.com/room?avatarUrl=URL_AVATAR_GLB
```

**Ideal para:**
- Prototipado rápido
- Testing de avatares
- Cuando no puedes modificar Hubs

---

### B. iFrame in Editor (Complejidad: 🟡 Media) ⭐ RECOMENDADO

**Integrar Avaturn en el editor de avatares de Hubs.**

**Archivos a modificar:**
```
hubs/src/
├── react-components/avatar-editor.js     # Agregar tab Avaturn
├── utils/avatar-utils.js                 # Agregar tipo AVATURN
└── assets/stylesheets/avatar-editor.scss # Estilos
```

**Ver código completo en:** `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md` → Sección 8

**Ideal para:**
- ✅ Integración profesional
- ✅ Experiencia de usuario fluida
- ✅ Uso gratuito (sin API)
- ✅ Mantenimiento a largo plazo

---

### C. SDK Full Integration (Complejidad: 🔴 Alta)

**Usar el SDK de Avaturn con API.**

```bash
npm install @avaturn/sdk
```

**Requiere:**
- ❌ Plan PRO de Avaturn ($800/mes)
- ❌ API key
- ❌ Gestión de autenticación

**Ideal para:**
- Branding personalizado
- Control total de UI/UX
- Gestión independiente de usuarios

---

## 🛠️ Herramientas Incluidas

### 1. Avatar Validator

**Archivo:** `codigo/avatar-validator.js`

**¿Qué hace?**
- ✅ Valida avatares de Avaturn
- ✅ Detecta problemas (animaciones, texturas, skeleton)
- ✅ Procesa y optimiza para Hubs
- ✅ Filtra animaciones problemáticas (basado en fixes de ReadyPlayer.me)

**Uso:**

```javascript
import { AvaturnAvatarValidator } from './avatar-validator.js';

const validator = new AvaturnAvatarValidator();

// Cargar avatar
const gltf = await loadGLTF(avatarUrl);

// Validar
const validation = await validator.validate(gltf);
console.log('Válido:', validation.valid);
console.log('Errores:', validation.errors);
console.log('Advertencias:', validation.warnings);

// Procesar (optimizar)
const processedGltf = validator.process(gltf);

// Usar en Hubs
scene.add(processedGltf.scene);
```

**Características:**
- Filtra VectorKeyframeTracks (evita T-Pose flashing)
- Asegura material Bot_PBS requerido por Hubs
- Optimiza texturas (encoding, mipmaps)
- Agrega componentes de audio feedback
- Genera reportes detallados

---

### 2. Ejemplo de Integración

**Archivo:** `codigo/avaturn-integration-example.html`

**¿Qué es?**
Página HTML completa lista para usar que muestra:
- iFrame de Avaturn integrado
- Captura de avatar exportado
- Descarga de GLB
- Generación de URL para Hubs
- UI completa y responsive

**Uso:**
```bash
# Simplemente abrir en navegador
open avaturn-integration-example.html
```

**Características:**
- ✅ Sin dependencias (HTML + CSS + JS vanilla)
- ✅ Responsive design
- ✅ Manejo de errores
- ✅ UI profesional
- ✅ Copiar/pegar código fácilmente

---

## ⚠️ Problemas Conocidos

### Problema 1: T-Pose Flashing

**Síntoma:** Avatar parpadea volviendo a T-Pose

**Causa:** VectorKeyframeTracks incompatibles

**Solución:** Usar `AvaturnAvatarValidator.filterAnimations()`

```javascript
validator.filterAnimations(gltf);
```

---

### Problema 2: Texturas No Cargan

**Síntoma:** Avatar negro o sin texturas

**Causa:** Encoding incorrecto o CORS

**Solución:**

```javascript
// Usar proxy para CORS
const proxiedUrl = `/api/v1/media?url=${encodeURIComponent(avatarUrl)}`;

// Configurar encoding
material.map.encoding = THREE.sRGBEncoding;
```

---

### Problema 3: Audio Feedback No Funciona

**Síntoma:** Avatar no escala cuando usuario habla

**Solución:** Agregar componente `scale-audio-feedback`

```javascript
validator.addHubsComponents(gltf); // Agrega automáticamente
```

**Ver más problemas y soluciones:** `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md` → Sección 9

---

## 📊 Comparación de Opciones

| Aspecto | URL Params | iFrame Editor | SDK Full |
|---------|-----------|---------------|----------|
| **Complejidad** | 🟢 Baja | 🟡 Media | 🔴 Alta |
| **Costo** | 💰 Gratis | 💰 Gratis | 💰 $800/mes |
| **Integración** | ⚠️ Externa | ✅ Integrada | ✅ Integrada |
| **UI/UX** | ⚠️ Básica | ✅ Buena | ✅ Excelente |
| **Mantenimiento** | 🟢 Bajo | 🟡 Medio | 🔴 Alto |
| **Tiempo setup** | ⏱️ 5 min | ⏱️ 2-4 horas | ⏱️ 1-2 días |

**Recomendación:** ⭐ **iFrame Editor** (Opción B)

---

## 🔧 Requisitos Técnicos

### Para Desarrollo

```json
{
  "node": ">=14.x",
  "npm": ">=6.x",
  "webpack": ">=4.x",
  "three.js": ">=r128"
}
```

### Navegadores Soportados

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+ (limitado)
- ⚠️ Mobile browsers (performance variable)

### Formato de Avatar

```
Avatar.glb (Avaturn)
├── Formato: GLB (GLTF 2.0 binary)
├── Vértices: ~50,000 - 100,000
├── Texturas: 4K - 8K PBR
├── Rigging: 60+ bones humanoid
├── Blendshapes: 51 ARKit (T2 avatars)
└── Visemes: phoneme shapes (T2 avatars)
```

---

## 📝 Checklist de Implementación

### Fase 1: Setup (30 min)

- [ ] Leer README.md (este archivo)
- [ ] Probar `avaturn-integration-example.html`
- [ ] Crear avatar de prueba en Avaturn
- [ ] Verificar que GLB descarga correctamente

### Fase 2: Integración Básica (2-3 horas)

- [ ] Leer `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md` sección 7
- [ ] Modificar `avatar-utils.js`
- [ ] Modificar `avatar-editor.js`
- [ ] Agregar estilos CSS
- [ ] Testing básico

### Fase 3: Validación (1 hora)

- [ ] Integrar `AvaturnAvatarValidator`
- [ ] Testing con diferentes tipos de avatar (T1, T2)
- [ ] Testing con diferentes body types (v2023, v2024)
- [ ] Verificar filtrado de animaciones

### Fase 4: Optimización (1-2 horas)

- [ ] Implementar cache de avatares
- [ ] Optimizar texturas
- [ ] Testing de performance
- [ ] Testing multiplayer

### Fase 5: Production (30 min)

- [ ] Testing exhaustivo (checklist completo)
- [ ] Documentación para usuarios
- [ ] Deploy

---

## 🆘 Soporte y Comunidad

### Recursos Oficiales

- **Hubs Foundation:** https://github.com/Hubs-Foundation/hubs
- **Avaturn Docs:** https://docs.avaturn.me
- **A-Frame Docs:** https://aframe.io/docs
- **Three.js Docs:** https://threejs.org/docs

### Comunidades

- **Hubs Discord:** https://discord.gg/dFJncWwHun
- **Avaturn Discord:** https://discord.com/invite/FfavuatXrz
- **WebXR Discord:** https://discord.gg/Jt5tfaM

### Issues Conocidos

- **ReadyPlayer.me #5964:** Half-body avatars problems
- **Hubs #5532:** Third-person view
- **Hubs #4847:** Speaking indicators

---

## 🎓 Recursos de Aprendizaje

### Para Principiantes

1. **Tutorial básico de Hubs:**
   - https://docs.hubsfoundation.org/docs/welcome.html

2. **Tutorial de A-Frame:**
   - https://aframe.io/docs/1.3.0/introduction/

3. **Avaturn Quick Start:**
   - https://docs.avaturn.me/docs/what-is-avaturn/

### Para Avanzados

1. **Arquitectura de Hubs:**
   - Ver: `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md` → Sección 3

2. **Sistema de avatares de Hubs:**
   - Ver: `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md` → Sección 3

3. **BELIVVR XRcloud (fork avanzado):**
   - https://github.com/luke-n-alpha/XRcloud

---

## 📦 Estructura de Archivos

```
Avaturn/
│
├── README.md                                # ← Este archivo
│   └── Guía rápida de inicio (5-10 min lectura)
│
├── IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md  # Documentación completa
│   ├── 12,000+ líneas de código y documentación
│   ├── 10 secciones principales
│   ├── Código completo de implementación
│   ├── Problemas conocidos y soluciones
│   └── Referencias y recursos
│
└── codigo/
    ├── avatar-validator.js                 # Validador de avatares
    │   ├── Validación de skeleton, materiales, texturas
    │   ├── Procesamiento y optimización
    │   └── Filtrado de animaciones problemáticas
    │
    └── avaturn-integration-example.html    # Ejemplo HTML completo
        ├── iFrame de Avaturn integrado
        ├── Captura de avatar exportado
        ├── Descarga de GLB
        └── Generación de URL para Hubs
```

---

## 🚦 Siguiente Paso

### ¿Nuevo en esto?
➡️ **Abre:** `codigo/avaturn-integration-example.html` (5 min)

### ¿Listo para implementar?
➡️ **Lee:** `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md` → Sección 7

### ¿Necesitas ayuda?
➡️ **Únete:** Hubs Discord o Avaturn Discord

---

## 💡 Tips Rápidos

### 1. Usar Demo de Avaturn
```
https://demo.avaturn.dev/
```
Subdomain gratuito para testing. Para producción, registra tu propio subdomain en developer.avaturn.me

### 2. Validar Siempre
```javascript
const validation = await validator.validate(gltf);
if (!validation.valid) {
  console.error("Errores:", validation.errors);
}
```

### 3. Filtrar Animaciones
```javascript
validator.filterAnimations(gltf); // Evita T-Pose flashing
```

### 4. Cache de Avatares
Implementa cache para mejor performance (ver código en documentación completa)

### 5. Testing en VR
Siempre testa en VR, no solo desktop. Problemas de escala y IK pueden aparecer solo en VR.

---

## 📅 Changelog

**v1.0 - Enero 2026**
- ✅ Documentación completa de implementación
- ✅ Código de validador listo para usar
- ✅ Ejemplo HTML funcional
- ✅ Guía paso a paso
- ✅ Problemas conocidos documentados

---

## 📄 Licencia

Esta documentación está basada en:
- **Mozilla Hubs:** Mozilla Public License 2.0
- **Avaturn:** Términos de servicio de Avaturn
- **Código de ejemplo:** MIT License

---

## 🙏 Agradecimientos

- **Hubs Foundation** por mantener Mozilla Hubs
- **Avaturn** por el SDK y documentación
- **BELIVVR** por XRcloud y mejoras open-source
- **Comunidad de ReadyPlayer.me** por documentar problemas y soluciones

---

## 📬 Contacto

**¿Preguntas o problemas?**

- Discord Hubs: https://discord.gg/dFJncWwHun
- Discord Avaturn: https://discord.com/invite/FfavuatXrz
- GitHub Issues: https://github.com/Hubs-Foundation/hubs/issues

---

**Happy Coding! 🚀**

*Creado con 🤖 para la comunidad de Mozilla Hubs*
*Enero 2026*
