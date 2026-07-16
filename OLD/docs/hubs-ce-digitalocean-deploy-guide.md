# Deploy Completo de Hubs Community Edition en DigitalOcean

## Con cert-manager para SSL automático (sin mantenimiento manual)

**Versión objetivo:** `prod-2025-12-17` (imagen Docker: `stable-3108`)
**Coste estimado:** ~$50 USD/mes (nodo 8GB + load balancer + storage)
**Tiempo estimado:** 1-2 horas
**Usuarios soportados:** ~20-30 concurrentes cómodamente con 8GB RAM

---

## Orden de Operaciones (Resumen)

Sigue este orden exacto. No saltes pasos.

```
1.  Comprar dominio
2.  Configurar SMTP (Scaleway)
3.  Crear cluster Kubernetes en DigitalOcean
4.  Conectar kubectl y doctl al cluster
5.  Configurar Firewall en DigitalOcean (ANTES del deploy)
6.  Instalar cert-manager + ClusterIssuer
7.  Descargar Hubs CE y editar input-values.yaml
8.  Generar hcce.yaml y verificar
9.  Modificar hcce.yaml (cert-manager + imagen)
10. Deploy: kubectl apply
11. Obtener IP del Load Balancer
12. Configurar DNS (4 registros A)
13. Esperar certificados SSL
14. Login y verificación
```

---

## Requisitos Previos

### Cuentas necesarias

- **DigitalOcean** — hosting del cluster Kubernetes ([digitalocean.com](https://www.digitalocean.com))
- **Registrador de dominio** — cualquiera sirve (Porkbun, Namecheap, Cloudflare, etc.)
- **Proveedor SMTP** — Scaleway Transactional Email recomendado ([scaleway.com](https://www.scaleway.com))

### Software local

- **Node.js** — descargar desde [nodejs.org](https://nodejs.org)
- **kubectl** — debe coincidir ±1 versión con tu cluster (ej: cluster 1.31 → kubectl 1.30, 1.31 o 1.32)
- **doctl** — CLI de DigitalOcean ([docs.digitalocean.com/reference/doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/))
- **Helm** — gestor de paquetes para Kubernetes ([helm.sh/docs/intro/install](https://helm.sh/docs/intro/install/))
- **Git** — para clonar el repositorio

---

## Paso 1: Comprar el Dominio

Compra un dominio en tu registrador preferido. El dominio solo puede contener caracteres alfanuméricos, puntos y guiones (requisito de compatibilidad con Scaleway SMTP).

**No configures DNS todavía** — necesitas la IP del load balancer que obtendrás más adelante.

---

## Paso 2: Configurar SMTP con Scaleway

1. Crea una cuenta en [Scaleway](https://www.scaleway.com)
2. Activa el servicio **Transactional Email**
3. Configura y verifica tu dominio en Scaleway (añade los registros SPF, DKIM y MX que te indiquen)
4. Genera credenciales API y guarda estos datos:

```
SMTP_SERVER: smtp.tem.scw.cloud
SMTP_PORT: 2587
SMTP_USER: (tu username de Scaleway — NO el Access Key ID)
SMTP_PASS: (tu Secret Key de Scaleway)
```

> **IMPORTANTE:** DigitalOcean bloquea los puertos SMTP estándar (25, 465, 587) como medida anti-spam. Por eso usamos el puerto **2587** de Scaleway.

> **NOTA:** Gmail como email de admin da problemas con varios proveedores SMTP. Usa un email con dominio propio si es posible.

---

## Paso 3: Crear el Cluster de Kubernetes en DigitalOcean

1. En DigitalOcean → **Kubernetes** → **Create Kubernetes Cluster**
2. Configuración:

| Parámetro | Valor |
|-----------|-------|
| Versión Kubernetes | La más reciente disponible (1.31+) |
| Región | La más cercana a tus usuarios |
| Scaling | Fixed (control de costes) |
| Machine type | Basic, Regular SSD |
| Node plan | **$48/mes** — 8GB RAM / 4 vCPUs |
| Número de nodos | **1** |
| High Availability | No (ahorra $40/mes) |

3. Nombra el cluster (ej: `hcce-production-2026`). Solo minúsculas, números y guiones.
4. Espera a que se provisione (~5 minutos)
5. **Anota la versión de Kubernetes** que te asigna — la necesitas para verificar compatibilidad de kubectl.

> **¿Por qué 8GB?** Hubs CE necesita 3-3.5 GB solo para los servicios base. Con 14 usuarios concurrentes se han medido ~2.6 GB de RAM. Con 8GB tienes margen para 20-30 usuarios sin estrés. El nodo de 4GB ($24/mes) funciona pero va justo para más de 5-10 personas.

---

## Paso 4: Conectar kubectl y doctl a tu Cluster

### Autenticar doctl

```bash
# Genera un API token en DigitalOcean → Settings → API → Generate New Token
# Selecciona "No expire" y "Full Access"

doctl auth init --context hubs-prod
# Pega tu token cuando lo pida

doctl auth switch --context hubs-prod
```

### Conectar kubectl al cluster

```bash
# Ve a DigitalOcean → Kubernetes → tu cluster → "Connecting to Kubernetes"
# Copia el comando automatizado, será algo como:

doctl kubernetes cluster kubeconfig save hcce-production-2026
```

### Verificar conexión

```bash
kubectl cluster-info
kubectl get nodes
# Deberías ver tu nodo con STATUS "Ready"
```

---

## Paso 5: Configurar Firewall en DigitalOcean

> **¿Por qué AHORA y no después?** cert-manager necesita que el puerto 80 esté abierto para completar los challenges HTTP-01 de Let's Encrypt. Si configuras el firewall después del deploy, los certificados no se emitirán y tendrás que esperar y reintentar. Configurarlo primero evita ese problema.

Ve a **DigitalOcean → Networking → Firewalls → Create Firewall**.

### Reglas de entrada (Inbound)

Elimina la regla SSH que viene por defecto. Crea estas 5 reglas:

| Tipo | Protocolo | Puerto(s) | Fuente | Propósito |
|------|-----------|-----------|--------|-----------|
| Custom | TCP | 80 | All IPv4 + All IPv6 | HTTP — challenges ACME de cert-manager |
| Custom | TCP | 443 | All IPv4 + All IPv6 | HTTPS — tráfico web principal |
| Custom | TCP | 4443 | All IPv4 + All IPv6 | Protocolo específico de Hubs |
| Custom | TCP | 5349 | All IPv4 + All IPv6 | STUN/TURN — WebRTC NAT traversal |
| Custom | UDP | 35000-60000 | All IPv4 + All IPv6 | WebRTC media — voz y vídeo |

### Aplicar al cluster

En la sección "Apply to Droplets", escribe el nombre de tu cluster (empieza con `hcce-`). Si aparece un tag, úsalo.

---

## Paso 6: Instalar cert-manager

Este es el componente que gestionará los certificados SSL automáticamente.

### Instalar con Helm

```bash
# Añadir repositorio
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Instalar cert-manager
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --set webhook.timeoutSeconds=10
```

> **CRÍTICO para DigitalOcean:** El flag `--set webhook.timeoutSeconds=10` es **obligatorio**. El valor por defecto (30s) supera el límite del clusterlint de DO (máximo 29s) y bloquea futuras actualizaciones de Kubernetes.

### Verificar instalación

```bash
kubectl get pods -n cert-manager

# Deberías ver 3 pods en estado Running:
#   cert-manager-xxxxx                  1/1   Running
#   cert-manager-cainjector-xxxxx       1/1   Running
#   cert-manager-webhook-xxxxx          1/1   Running
```

**Espera a que los 3 pods estén en `Running` antes de continuar** (~1-2 minutos).

### Crear el ClusterIssuer de Let's Encrypt

Crea un archivo llamado `cluster-issuer.yaml`:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    email: TU_EMAIL_REAL@ejemplo.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            ingressClassName: haproxy
```

> **NOTA:** Usa `ingressClassName: haproxy` (no la annotation vieja `class: haproxy`). Es el método recomendado desde cert-manager v1.12+ y es el que funciona correctamente con el solver HTTP-01.

Aplícalo:

```bash
kubectl apply -f cluster-issuer.yaml
```

Verifica:

```bash
kubectl get clusterissuer letsencrypt-prod
# La columna READY debería mostrar "True"
# Si muestra "False", espera 30 segundos y vuelve a comprobar
```

---

## Paso 7: Descargar y Configurar Hubs Community Edition

### Clonar el repositorio

```bash
git clone https://github.com/Hubs-Foundation/hubs-cloud.git
cd hubs-cloud/community-edition
```

### Instalar dependencias

```bash
npm ci
```

### Editar input-values.yaml

Abre `input-values.yaml` y configura:

```yaml
HUB_DOMAIN: tudominio.com
ADM_EMAIL: tu-email-admin@ejemplo.com
Namespace: hcce

SMTP_SERVER: smtp.tem.scw.cloud
SMTP_PORT: 2587
SMTP_USER: tu-username-scaleway
SMTP_PASS: tu-secret-key-scaleway

SKETCHFAB_API_KEY: (opcional — déjalo vacío si no lo usas)

# IMPORTANTE: Genera valores únicos aleatorios para estos tres campos
# Usa un generador de contraseñas (mínimo 32 caracteres, solo alfanuméricos)
NODE_COOKIE: genera_un_valor_aleatorio_largo_aqui
GUARDIAN_KEY: genera_otro_valor_aleatorio_largo_aqui
PHX_KEY: genera_otro_valor_aleatorio_largo_aqui
```

> **CUIDADO con las credenciales SMTP:** Asegúrate de usar tu **Username** de Scaleway y tu **Secret Key**, NO tu Access Key ID. Este error es la causa #1 de fallos en el magic link.

### Generar el manifiesto

```bash
npm run gen-hcce
```

### Verificar que se generó correctamente

```bash
ls -lh hcce.yaml
# El archivo debería existir y pesar entre 50KB y 250KB
# Si no existe o pesa 0 bytes, hubo un error en la generación
```

---

## Paso 8: Modificar hcce.yaml para cert-manager

Este es el paso clave. Necesitas hacer **cuatro modificaciones** en el `hcce.yaml` generado.

### 8a. Verificar que los Ingresses tienen bloques TLS

Antes de añadir nada, confirma que los ingresses ya tienen la sección `spec.tls`. El template oficial los incluye, pero verifica:

```bash
grep -c "secretName: cert-" hcce.yaml
# Debería devolver 7 (hay 7 referencias a secretos TLS en los 3 ingresses)
# Si devuelve 0, tu hcce.yaml no tiene TLS — revisa el paso 7
```

Las secciones TLS de los ingresses ya referencian secretNames como `cert-tudominio.com`, `cert-assets.tudominio.com`, etc. cert-manager creará automáticamente esos secrets cuando emita los certificados.

### 8b. Añadir annotation de cert-manager a los tres Ingresses

Busca los tres recursos Ingress (`ret`, `dialog`, `nearspark`) y añade **una sola línea** a cada uno: `cert-manager.io/cluster-issuer: "letsencrypt-prod"`. Las annotations existentes de HAProxy se mantienen intactas.

**Ingress "ret"** — busca `name: ret` de tipo Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ret
  namespace: hcce
  annotations:
    kubernetes.io/ingress.class: haproxy
    cert-manager.io/cluster-issuer: "letsencrypt-prod"    # <-- AÑADIR
    haproxy.org/response-set-header: |
      access-control-allow-origin "https://tudominio.com"
    haproxy.org/path-rewrite: /api-internal(.*) /_drop_
```

**Ingress "dialog"** — busca `name: dialog` de tipo Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dialog
  namespace: hcce
  annotations:
    kubernetes.io/ingress.class: haproxy
    cert-manager.io/cluster-issuer: "letsencrypt-prod"    # <-- AÑADIR
    haproxy.org/server-ssl: "true"
    haproxy.org/load-balance: "url_param roomId"
```

**Ingress "nearspark"** — busca `name: nearspark` de tipo Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nearspark
  namespace: hcce
  annotations:
    kubernetes.io/ingress.class: haproxy
    cert-manager.io/cluster-issuer: "letsencrypt-prod"    # <-- AÑADIR
    haproxy.org/path-rewrite: /nearspark/(.*) /\1
```

### 8c. Gestionar el certificado bootstrap de HAProxy

El deployment de HAProxy tiene esta línea en sus args:

```yaml
- --default-ssl-certificate=hcce/cert-hcce
```

**NO la comentes todavía.** Este certificado autofirmado (`cert-hcce`) es necesario para que HAProxy arranque sin errores. Si lo quitas antes de que cert-manager haya emitido los certificados reales, HAProxy podría fallar al arrancar porque los secrets TLS (`cert-tudominio.com`, etc.) aún no existen.

**El plan es:**
1. Deploy con `--default-ssl-certificate` activa (HAProxy arranca con cert autofirmado)
2. Esperar a que cert-manager emita los 4 certificados reales
3. Una vez verificados, comentar la línea y reaplicar (paso 13b)

### 8d. Usar la imagen específica de Hubs stable-3108

Busca la imagen del servicio `hubs` en el `hcce.yaml`. El template usa el registry `mozillareality`:

Busca:

```
image: mozillareality/hubs:stable-latest
```

Reemplaza con:

```
image: mozillareality/hubs:stable-3108
```

> **IMPORTANTE:** Solo cambia la imagen del servicio **hubs** (el cliente web). Los demás servicios (reticulum, dialog, spoke, coturn, haproxy, etc.) mantienen sus tags originales. La release `prod-2025-12-17` solo afecta al cliente web.

> **Nota sobre el registry:** El template oficial usa `mozillareality/` (el registry legacy de Mozilla). La organización Hubs Foundation también publica en `hubsfoundation/`. Ambos deberían tener la imagen `stable-3108`. Usa el que aparezca en tu hcce.yaml generado para mantener consistencia con el resto de imágenes.

---

## Paso 9: Deploy

```bash
kubectl apply -f hcce.yaml
```

### Verificar que todo arranca

```bash
kubectl get deployment -n hcce

# Todos deberían mostrar READY 1/1 en ~2 minutos
# Espera y repite si ves 0/1
```

Si algún deployment no arranca en 3 minutos:

```bash
# Ver qué pod está fallando
kubectl get pods -n hcce

# Ver logs del pod problemático
kubectl logs deployment/NOMBRE_DEPLOYMENT -n hcce

# Errores comunes:
# - ImagePullBackOff → nombre de imagen incorrecto
# - CrashLoopBackOff → error de configuración (revisa input-values.yaml)
# - Pending → falta de recursos (nodo sin RAM suficiente)
```

---

## Paso 10: Obtener la IP del Load Balancer

```bash
# Espera hasta que aparezca la IP (puede tardar 1-3 minutos)
kubectl -n hcce get svc lb -w

# Cuando veas un valor en EXTERNAL-IP (no <pending>), pulsa Ctrl+C
```

Guarda la IP. Si tras 5 minutos sigue en `<pending>`:

```bash
kubectl describe svc lb -n hcce | grep -A5 "Events"
```

---

## Paso 11: Configurar DNS

Ve a tu registrador de dominio y crea **4 registros A** apuntando a la IP del load balancer:

| Host | Tipo | Valor |
|------|------|-------|
| `@` | A | IP_DEL_LOAD_BALANCER |
| `assets` | A | IP_DEL_LOAD_BALANCER |
| `cors` | A | IP_DEL_LOAD_BALANCER |
| `stream` | A | IP_DEL_LOAD_BALANCER |

Los 4 registros apuntan a la **misma IP**.

> **NOTA sobre Porkbun:** El `@` puede desaparecer después de guardarlo. Esto es normal en Porkbun y funciona correctamente.

### Verificar propagación DNS

```bash
dig tudominio.com +short
dig assets.tudominio.com +short
dig cors.tudominio.com +short
dig stream.tudominio.com +short
# Los cuatro deberían devolver la IP del load balancer
```

Si no tienes `dig`, usa [whatsmydns.net](https://www.whatsmydns.net) para verificar online. La propagación puede tardar entre 5 minutos y varias horas dependiendo del registrador.

---

## Paso 12: Esperar y Verificar Certificados SSL

Una vez que el DNS propague, cert-manager comenzará automáticamente a solicitar los certificados a Let's Encrypt.

### Monitorizar el estado

```bash
# Ver los Certificate resources
kubectl get certificates -n hcce

# Deberías ver hasta 4 certificados (uno por host definido en los ingresses TLS)
# El campo READY debería cambiar a "True" en 2-5 minutos después de que DNS propague
```

Si los certificados no aparecen o quedan en `False`:

```bash
# Ver si hay challenges pendientes
kubectl get challenges -n hcce

# Detalle de un challenge específico
kubectl describe challenge -n hcce

# Logs de cert-manager
kubectl logs deployment/cert-manager -n cert-manager --tail=50
```

**Errores comunes y soluciones:**

| Síntoma | Causa probable | Solución |
|---------|---------------|----------|
| Challenge en Pending | DNS no propagado | Espera y verifica con `dig` |
| Challenge falla con 404 | Puerto 80 bloqueado | Verifica firewall (paso 5) |
| No aparecen Certificates | Falta annotation en ingress | Verifica paso 8b |
| ClusterIssuer no Ready | cert-manager no arrancó bien | `kubectl get pods -n cert-manager` |

### Verificar en navegador

Accede a `https://tudominio.com`. Deberías ver la página de login de Hubs con certificado SSL válido (candado verde).

> **Si ves un aviso de seguridad:** es porque HAProxy está sirviendo el certificado bootstrap autofirmado (`cert-hcce`). Esto es normal si los certificados reales aún no se han emitido. Espera a que cert-manager termine.

---

## Paso 13: Finalizar Configuración SSL

### 13a. Confirmar que todos los certificados están Ready

```bash
kubectl get certificates -n hcce
# TODOS deben mostrar READY = True
```

### 13b. Comentar el certificado bootstrap (ahora sí)

Ahora que cert-manager ha creado los certificados reales, ya puedes desactivar el fallback autofirmado.

Edita `hcce.yaml` y comenta la línea en el deployment de HAProxy:

```yaml
        args:
        - --configmap=hcce/haproxy-config
        - --https-bind-port=4443
        - --http-bind-port=8080
        - --configmap-tcp-services=hcce/haproxy-tcp-config
        - --ingress.class=haproxy
        - --log=warning
        # - --default-ssl-certificate=hcce/cert-hcce    # <-- COMENTAR AHORA
```

Reaplicar:

```bash
kubectl apply -f hcce.yaml
```

Verificar que HAProxy se reinicia correctamente:

```bash
kubectl get pods -n hcce | grep haproxy
# Debería estar Running
```

Accede otra vez a `https://tudominio.com` y confirma candado verde sin warnings.

> **Si HAProxy falla después de comentar esta línea:** Descomenta la línea, reaplicar, y revisa que los certificados realmente estén como READY True. El fallback autofirmado es tu red de seguridad.

---

## Paso 14: Login y Configuración Inicial

1. Accede a `https://tudominio.com`
2. Introduce tu email de admin (el que configuraste en `ADM_EMAIL`)
3. Pulsa "Next"
4. Revisa tu email y haz clic en el magic link
5. Deberías entrar al lobby de Hubs

### Panel de Administración

Accede a `https://tudominio.com/admin` para:

- Configurar habitaciones por defecto
- Gestionar usuarios
- Importar escenas
- Configurar límites de ocupación
- Activar modo invitación

---

## Verificación Post-Deploy Completa

Ejecuta todas estas comprobaciones:

```bash
# 1. Todos los pods corriendo
kubectl get pods -n hcce
# Todos deberían estar Running

# 2. Todos los deployments ready
kubectl get deployment -n hcce
# Todos con READY 1/1

# 3. Certificados SSL válidos
kubectl get certificates -n hcce
# Todos con READY True

# 4. Verificar conectividad SMTP
RET_POD=$(kubectl get pod -n hcce -l app=reticulum -o jsonpath='{.items[0].metadata.name}')
kubectl exec $RET_POD -c reticulum -n hcce -- nc -zv smtp.tem.scw.cloud 2587
# Debería devolver "open"

# 5. Verificar imagen de Hubs
kubectl get deployment hubs -n hcce -o jsonpath='{.spec.template.spec.containers[0].image}'
# Debería mostrar: mozillareality/hubs:stable-3108
```

### Test funcional

1. Crea una sala desde el lobby
2. Verifica que se renderiza (cielo gris, avatares de caja es normal en la sala por defecto)
3. Abre la sala en una segunda pestaña o dispositivo
4. Verifica que los dos avatares se ven mutuamente
5. Activa el micrófono y verifica que hay audio bidireccional

---

## Mantenimiento (Casi Nulo)

### Certificados SSL — Automático

**No necesitas hacer nada.** cert-manager renueva automáticamente los certificados cuando quedan ~30 días para expirar. La renovación ocurre en background sin downtime — HAProxy empieza a usar el nuevo certificado automáticamente.

Para verificar las fechas de expiración:

```bash
kubectl get certificates -n hcce -o wide
```

Si un certificado se queda atascado y no renueva:

```bash
# Ver si hay challenges pendientes
kubectl get challenges -n hcce

# Forzar renovación eliminando el secret (cert-manager lo recreará)
kubectl delete secret cert-tudominio.com -n hcce
```

### Actualizar la versión de Hubs

Cuando haya una nueva release en [github.com/Hubs-Foundation/hubs/releases](https://github.com/Hubs-Foundation/hubs/releases):

```bash
kubectl set image deployment/hubs hubs=mozillareality/hubs:stable-NUEVO_TAG -n hcce
kubectl rollout restart deployment/hubs -n hcce
```

### Backups

DigitalOcean Block Storage Volumes no se respaldan con los snapshots estándar de DO.

```bash
# Backup de la base de datos (RECOMENDADO antes de cualquier cambio)
RET_POD=$(kubectl get pod -n hcce -l app=pgsql -o jsonpath='{.items[0].metadata.name}')
kubectl exec $RET_POD -n hcce -- pg_dump -U postgres ret_dev > backup_$(date +%Y%m%d).sql

# Backup integrado de Hubs CE (si disponible en tu versión)
cd hubs-cloud/community-edition
npm run backup
```

> **Haz backup SIEMPRE antes de:** actualizar versiones, borrar PVCs, o hacer cambios en hcce.yaml que afecten a la base de datos.

### Reiniciar si algo falla

```bash
# Reinicio graceful de todos los servicios
kubectl rollout restart deployment -n hcce

# Si no responde, reinicio completo (pods se recrean automáticamente)
kubectl delete pods --all -n hcce
```

### Monitorizar recursos

```bash
# Ver uso de CPU y RAM por pod (requiere metrics-server)
kubectl top pods -n hcce

# Referencia de consumo medido (datos reales, diciembre 2025):
#   Idle:           ~112m CPU, ~1513Mi RAM
#   14 usuarios:    ~211m CPU, ~2646Mi RAM
#   20+ usuarios:   ~300m CPU, ~3500Mi RAM (estimado)
#   Pod Dialog:     3m idle → 114m con 22 usuarios
#   Pod Reticulum:  12m idle → 213m con 21 usuarios
```

---

## Troubleshooting

### Los certificados no se emiten

```bash
# 1. Verificar DNS
dig tudominio.com +short
# Debe devolver la IP del LB. Si no, DNS no ha propagado.

# 2. Verificar challenges
kubectl get challenges -n hcce
kubectl describe challenge -n hcce

# 3. Verificar que HAProxy acepta tráfico en puerto 80
kubectl logs deployment/haproxy -n hcce --tail=20

# 4. Logs de cert-manager
kubectl logs deployment/cert-manager -n cert-manager --tail=50
```

### El magic link de login no llega

```bash
# Encontrar pod de reticulum y testear SMTP
RET_POD=$(kubectl get pod -n hcce -l app=reticulum -o jsonpath='{.items[0].metadata.name}')
kubectl exec $RET_POD -c reticulum -n hcce -- nc -zv smtp.tem.scw.cloud 2587

# Si está cerrado, verifica:
# 1. Puerto 2587 (no 587) en input-values.yaml
# 2. SMTP_USER = Username de Scaleway (no Access Key ID)
# 3. SMTP_PASS = Secret Key de Scaleway
# 4. Dominio verificado en Scaleway
# Después de corregir, regenera hcce.yaml y reaplica
```

### Error "FailedScheduling" o "Unbound PersistentVolumeClaims"

> **ADVERTENCIA: Los comandos siguientes borran la base de datos.** Haz backup primero.

```bash
# Backup primero
kubectl exec deployment/pgsql -n hcce -- pg_dump -U postgres ret_dev > backup_emergencia.sql

# Luego recrea los volúmenes
kubectl delete --all pods -n hcce
kubectl delete pvc pgsql-pvc -n hcce
kubectl delete pv pgsql-pv -n hcce
kubectl delete pvc ret-pvc -n hcce
kubectl delete pv ret-pv -n hcce
kubectl apply -f hcce.yaml
```

### CORS/500 errors en el editor de escenas

```bash
kubectl scale deployments --all --replicas=0 -n hcce
# Esperar 30 segundos
kubectl scale deployments --all --replicas=1 -n hcce
```

### Connection reset después de reiniciar el Droplet

```bash
kubectl rollout restart deployment -n hcce
```

### Rollback: Volver al certificado manual si cert-manager falla

Si cert-manager da problemas irrecuperables y necesitas volver al flujo manual de certbot:

```bash
# 1. Restaurar default-ssl-certificate en HAProxy
# Descomenta la línea en hcce.yaml:
#   - --default-ssl-certificate=hcce/cert-hcce

# 2. Quitar annotations de cert-manager de los 3 ingresses
# Elimina: cert-manager.io/cluster-issuer: "letsencrypt-prod"

# 3. Reaplicar
kubectl apply -f hcce.yaml

# 4. Usar el flujo original de certbot
npm run gen-ssl
# Después, comentar --default-ssl-certificate en hcce.yaml y reaplicar
```

---

## Resumen de Arquitectura Final

```
Internet
    │
    ▼
┌─────────────────────────────────────────────────┐
│  DigitalOcean Load Balancer                     │
│  Puertos: 80, 443, 4443, 5349                  │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  HAProxy Ingress Controller                     │
│  (mozillareality/haproxy — fork de Hubs)        │
│  - Routing por host/path                        │
│  - Terminación TLS (certs de cert-manager)      │
└───┬─────────┬──────────┬───────────┬────────────┘
    │         │          │           │
    ▼         ▼          ▼           ▼
┌───────┐ ┌───────┐ ┌────────┐ ┌──────────┐
│ Hubs  │ │ Ret   │ │ Dialog │ │ Nearspark│
│Client │ │iculum │ │(WebRTC)│ │(img proxy│
│:8080  │ │:4001  │ │:4443   │ │:5000)    │
└───────┘ └───┬───┘ └────────┘ └──────────┘
              │
              ▼
        ┌──────────┐
        │PostgreSQL│
        │  :5432   │
        └──────────┘

┌─────────────────────────────────────────────────┐
│  cert-manager (namespace: cert-manager)         │
│  - ClusterIssuer: letsencrypt-prod              │
│  - Renueva certs automáticamente cada ~60 días  │
│  - HTTP-01 challenges via HAProxy               │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Coturn (STUN/TURN)                             │
│  Puerto 5349 (TCP) + 35000-60000 (UDP)          │
│  NAT traversal para WebRTC                      │
└─────────────────────────────────────────────────┘
```

> **Nota:** La imagen de HAProxy es `mozillareality/haproxy`, que es un build custom de Hubs con configuraciones específicas para el routing de Reticulum, Dialog y Nearspark. **No la sustituyas** por `haproxytech/kubernetes-ingress` (la oficial de HAProxy Technologies) — romperá el routing.

---

## Checklist Final

- [ ] Dominio comprado
- [ ] Dominio verificado en Scaleway (SPF, DKIM, MX)
- [ ] Credenciales SMTP guardadas (server, port 2587, username, secret key)
- [ ] Cluster K8s creado en DigitalOcean (8GB RAM, 4 vCPUs)
- [ ] kubectl y doctl autenticados y conectados al cluster
- [ ] **Firewall configurado** (TCP 80, 443, 4443, 5349 + UDP 35000-60000)
- [ ] cert-manager instalado con `webhook.timeoutSeconds=10`
- [ ] 3 pods de cert-manager en Running
- [ ] ClusterIssuer `letsencrypt-prod` creado y Ready = True
- [ ] Repo `hubs-cloud` clonado y dependencias instaladas (`npm ci`)
- [ ] `input-values.yaml` configurado con dominio, email, SMTP, claves random
- [ ] `hcce.yaml` generado con `npm run gen-hcce` (verificado >50KB)
- [ ] Ingresses TLS verificados (`grep -c "secretName: cert-" hcce.yaml` = 7)
- [ ] Annotation `cert-manager.io/cluster-issuer` añadida a 3 ingresses
- [ ] `--default-ssl-certificate` **dejada activa** (se comentará en paso 13b)
- [ ] Imagen hubs cambiada a `stable-3108`
- [ ] Deploy aplicado con `kubectl apply -f hcce.yaml`
- [ ] Todos los deployments con READY 1/1
- [ ] IP del load balancer obtenida
- [ ] 4 registros DNS A creados (@, assets, cors, stream) → IP del LB
- [ ] DNS propagado (verificado con `dig`)
- [ ] Certificados SSL emitidos (todos con READY = True)
- [ ] `--default-ssl-certificate` comentada y hcce.yaml reaplicado (paso 13b)
- [ ] HAProxy arrancó bien después del cambio
- [ ] Login con magic link funciona
- [ ] Sala de prueba creada y renderizada
- [ ] Audio/vídeo funciona entre dos clientes
