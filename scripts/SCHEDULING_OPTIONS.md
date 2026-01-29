# Configuración de Horarios para Auto-Scaling de Hubs

## Horarios Recomendados por Defecto

### Días laborables (Lunes-Viernes)
- **Encendido**: 08:00 (hora local)
- **Apagado**: 23:00 (hora local)
- **Duración activa**: 15 horas/día

### Fines de semana (Sábado-Domingo)
- **Encendido**: 10:00 (hora local)
- **Apagado**: 22:00 (hora local)
- **Duración activa**: 12 horas/día

## Ahorro Estimado

Con esta configuración:
- **Horas activas/semana**: (15h × 5) + (12h × 2) = 99 horas
- **Horas apagadas/semana**: 168 - 99 = 69 horas (41% del tiempo)
- **Ahorro mensual estimado**: ~$50-60/mes (40-50% del costo actual)

## Opciones de Implementación

### Opción A: Cron Job Local (Requiere Mac encendido)
Usar `crontab` en tu Mac para ejecutar los scripts automáticamente.

**Ventajas:**
- Gratis
- Fácil de configurar

**Desventajas:**
- Tu Mac debe estar encendido y conectado
- No funciona si estás de viaje

### Opción B: GitHub Actions (Recomendado)
Usar GitHub Actions con cron schedule para ejecutar los scripts.

**Ventajas:**
- Completamente automático
- Funciona 24/7 sin tu intervención
- Gratis (2000 minutos/mes incluidos)
- Puedes ver historial de ejecuciones

**Desventajas:**
- Requiere configurar secrets de kubectl

### Opción C: DigitalOcean App Platform Function
Crear una función serverless que ejecute los scripts.

**Ventajas:**
- Nativa de DO
- Muy confiable

**Desventajas:**
- Costo adicional (~$5/mes)

## Personalización de Horarios

Si prefieres otros horarios, puedes modificar fácilmente:

1. **Para horario europeo estricto (9-18h)**:
   - Encendido: 09:00
   - Apagado: 18:00
   - Ahorro: ~55%

2. **Para uso nocturno ocasional**:
   - Lunes-Viernes: 08:00-01:00 (siguiente día)
   - Fin de semana: 24/7
   - Ahorro: ~30%

3. **Máximo ahorro (solo horario laboral)**:
   - Lunes-Viernes: 09:00-18:00
   - Fin de semana: APAGADO
   - Ahorro: ~70%

## ¿Qué opción prefieres?

Por favor indica:
1. **Método de automatización**: A, B o C
2. **Horarios**: Usar los recomendados o personalizados
3. **Zona horaria**: (detectada: Europe/Madrid UTC+1)
