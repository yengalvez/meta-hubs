# Integración ReadyPlayer.me Full-Body Avatars en Hubs Foundation 2.0.0

## Contenido del Paquete

Este directorio contiene toda la investigación técnica y código necesario para integrar avatares full-body de ReadyPlayer.me en tu instancia de Hubs Foundation 2.0.0.

### Archivos Principales

1. **`INTEGRACION_RPM_HUBS.md`** - Documento maestro de investigación (40+ páginas)
   - Estado del ecosistema RPM y Hubs
   - Arquitectura técnica completa
   - Comparación de esqueletos y sistemas de huesos
   - Problemas conocidos y soluciones
   - Guía de implementación paso a paso
   - Referencias completas

2. **`codigo/`** - Implementaciones de código
   - `avatar-utils-extended.js` - Validador de skeleton extendido
   - `fullbody-avatar-component.js` - Componente A-Frame full-body
   - `prepare-rpm-avatar.py` - Script Blender de pre-procesamiento

## Quick Start

### 1. Lectura Inicial (30 min)

Lee el documento principal para entender:
- Por qué Hubs no soporta full-body nativamente
- Diferencias entre skeleton Mixamo (RPM) y High Fidelity (Hubs)
- Arquitectura de XRCLOUD (única implementación open-source existente)

```bash
# Abrir documento principal
open INTEGRACION_RPM_HUBS.md
# o
cat INTEGRACION_RPM_HUBS.md | less
```

### 2. Preparar Avatar RPM (1 hora)

Antes de intentar subir tu avatar a Hubs, pre-procesalo con Blender:

```bash
# Instalar Blender si no lo tienes
# macOS: brew install --cask blender
# Linux: sudo apt install blender
# Windows: descargar de blender.org

# Procesar avatar
blender --background --python codigo/prepare-rpm-avatar.py -- \
  ~/Descargas/mi_avatar_rpm.glb \
  ~/Descargas/mi_avatar_hubs_ready.glb \
  --height 1.7
```

Esto:
- Valida skeleton Mixamo
- Ajusta escala a 1.7m de altura
- Centra en origen
- Exporta GLB optimizado

### 3. Setup de Desarrollo Hubs (2-3 horas)

```bash
# Clonar Hubs Foundation
git clone https://github.com/Hubs-Foundation/hubs.git hubs-rpm
cd hubs-rpm

# Crear rama de desarrollo
git checkout -b feature/rpm-fullbody

# Instalar dependencias
npm ci

# Copiar archivos de código
cp ../codigo/avatar-utils-extended.js src/utils/avatar-utils.js
cp ../codigo/fullbody-avatar-component.js src/components/fullbody-avatar.js

# Configurar .env
cp .env.defaults .env
# Editar .env con tu configuración

# Iniciar desarrollo
npm run dev
```

### 4. Testing Inicial (1 hora)

1. Abrir `https://localhost:8080`
2. Crear o unirse a una room
3. Click en avatar → "Avatar GLB URL"
4. Subir `mi_avatar_hubs_ready.glb`
5. Verificar consola del navegador para logs

**Checklist**:
- [ ] Avatar carga sin errores
- [ ] Skeleton se valida correctamente (ver logs)
- [ ] Upper body renderiza
- [ ] Lower body **no renderiza** (esperado sin más modificaciones)

### 5. Implementación Full-Body (15-20 horas)

Seguir la **Guía de Implementación** en `INTEGRACION_RPM_HUBS.md` sección correspondiente:

- **Fase 1**: Preparación del entorno ✅ (ya hecho arriba)
- **Fase 2**: Análisis de avatares RPM (4-6h)
- **Fase 3**: Modificación del core de Hubs (15-20h)
- **Fase 4**: Subida y validación (5-8h)
- **Fase 5**: Testing y debugging (8-12h)

## Estructura del Proyecto

```
RPM/
├── README.md (este archivo)
├── INTEGRACION_RPM_HUBS.md (documento principal - 40+ páginas)
└── codigo/
    ├── avatar-utils-extended.js (validador skeleton)
    ├── fullbody-avatar-component.js (componente A-Frame)
    └── prepare-rpm-avatar.py (script Blender)
```

## Conceptos Clave

### Skeleton Mixamo vs High Fidelity

**ReadyPlayer.me usa Mixamo** (53+ huesos, full-body):
```
Armature
├── Hips
│   ├── Spine → Spine1 → Spine2 → Neck → Head
│   ├── LeftUpLeg → LeftLeg → LeftFoot ✅ LOWER BODY
│   └── RightUpLeg → RightLeg → RightFoot ✅ LOWER BODY
```

**Hubs usa High Fidelity** (simplificado, half-body only):
```
Hips
├── Spine → Spine1 → Spine2 → Neck → Head
├── LeftArm → LeftForeArm → LeftHand
├── RightArm → RightForeArm → RightHand
└── ❌ Sin lower body
```

### Por Qué Hubs No Soporta Full-Body

De la documentación oficial:
> "Hubs ha eliminado lower body y arm joints porque no usan IK en este momento. Esto es principalmente porque Hubs es una aplicación web donde tiempos de descarga grandes pueden afectar el rendimiento, especialmente en móviles."

### Solución: XRCLOUD

XRCLOUD (by BELIVVR) implementó full-body en 2022-2024:
- Open source (MIT): https://github.com/luke-n-alpha/xrcloud
- Funcional pero con limitaciones (no integrado con bit-ecs)
- Descontinuado en 2025

**Podemos usar su código como referencia** pero necesitamos reimplementarlo correctamente.

## Problemas Conocidos

### 1. Nombres de Huesos Hard-Coded

**Síntoma**: `Error: Missing required bones`

**Causa**: Hubs valida nombres de huesos contra lista hard-coded que no incluye lower body

**Solución**: Usar `avatar-utils-extended.js` que acepta skeleton Mixamo

### 2. Lower Body No Renderiza

**Síntoma**: Solo se ve torso y brazos, piernas invisibles

**Causa**: Sistema de avatares de Hubs no renderiza lower body meshes

**Solución**: Componente `fullbody-avatar.js` + modificaciones en rendering

### 3. Animaciones de Piernas

**Síntoma**: Piernas en pose T estática

**Causa**: Sin IK ni animaciones procedurales para lower body

**Solución**: Sistema de animación procedural (implementado parcialmente en `fullbody-avatar-component.js`)

### 4. Performance

**Síntoma**: FPS bajo con múltiples avatares full-body

**Causa**: Más vértices, huesos, y complejidad de rendering

**Solución**: LOD system, optimización de geometría, limitar número de full-body simultáneos

## Recursos Adicionales

### Documentación Oficial

- [Hubs Foundation Docs](https://docs.hubsfoundation.org/)
- [Hubs Avatar Pipelines](https://github.com/Hubs-Foundation/hubs-avatar-pipelines)
- [Ready Player Me Docs](https://docs.readyplayer.me/)

### Issues Relevantes de GitHub

- [Full body avatars discussion #3203](https://github.com/Hubs-Foundation/hubs/discussions/3203)
- [3rd person view #5532](https://github.com/Hubs-Foundation/hubs/issues/5532)

### Código Open Source

- [XRCLOUD by BELIVVR](https://github.com/luke-n-alpha/xrcloud)
- [XRCLOUD Avatar Editor](https://github.com/belivvr/xrcloud-avatar-editor)

## FAQ

### ¿Puedo usar avatares RPM sin modificar Hubs?

**No.** Los avatares full-body RPM requieren modificaciones al core de Hubs. Half-body RPM puede funcionar con limitaciones.

### ¿Cuánto tiempo toma la implementación?

**40-60 horas de desarrollo** + 15-20 horas de testing. Depende de experiencia con Three.js, A-Frame, y bit-ecs.

### ¿Funcionará con futuras versiones de Hubs?

**Probablemente no sin mantenimiento.** Este es un fork custom que requiere actualización cuando Hubs Foundation lance nuevas versiones.

### ¿Puedo contribuir esto a Hubs Foundation oficial?

**Posible pero complejo.** Hubs Foundation indicó que no tienen full-body en su roadmap por razones de performance. Una PR requeriría demostrar que no impacta negativamente performance de usuarios que no usan full-body.

### ¿XRCLOUD es mejor opción que implementación propia?

**Depende.** XRCLOUD funciona pero:
- ❌ No integrado con bit-ecs moderno
- ❌ Proyecto descontinuado (sin mantenimiento)
- ❌ Limitaciones conocidas (jump bug, performance)
- ✅ Código de referencia valioso
- ✅ Prueba de concepto funcional

**Recomendación**: Estudiar XRCLOUD, pero implementar desde cero con bit-ecs.

## Contacto y Soporte

Este es un proyecto de investigación técnica. Para consultas:

1. **Issues técnicos de Hubs**: [GitHub Issues](https://github.com/Hubs-Foundation/hubs/issues)
2. **Discusiones de la comunidad**: [Hubs Discord](https://discord.gg/hubs)
3. **Documentación de este proyecto**: Ver `INTEGRACION_RPM_HUBS.md`

## Licencia

- Código de ejemplo: MIT License
- Documentación: CC BY 4.0

---

**Última actualización**: Febrero 2026
**Versión**: 1.0
**Estado**: Investigación completa, implementación por realizar
