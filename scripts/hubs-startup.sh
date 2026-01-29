#!/bin/bash
# Script para encender los servicios de Hubs
# Restaura los deployments a su estado original

set -e

NAMESPACE="hcce"
KUBECTL_PATH="./bin/kubectl"

echo "🟢 Encendiendo servicios de Hubs..."
echo "Fecha: $(date)"
echo ""

# Definir réplicas por deployment (configuración estándar)
declare -A REPLICAS=(
  ["moz-hubs-ce"]=1
  ["moz-reticulum"]=1
  ["moz-dialog"]=1
  ["moz-coturn"]=1
  ["moz-haproxy"]=1
  ["moz-spoke"]=1
  ["moz-nearspark"]=1
  ["moz-photomnemonic"]=1
  ["moz-pgsql"]=1
  ["moz-pgbouncer"]=1
  ["moz-pgbouncer-t"]=1
)

echo "Escalando deployments a sus réplicas originales..."
for deployment in "${!REPLICAS[@]}"; do
  replicas=${REPLICAS[$deployment]}
  echo "  - Encendiendo: $deployment (replicas=$replicas)"
  $KUBECTL_PATH scale deployment $deployment --replicas=$replicas -n $NAMESPACE 2>/dev/null || true
done

echo ""
echo "⏳ Esperando a que los pods estén listos..."
sleep 10

# Verificar estado de los pods
echo ""
echo "Estado de los servicios:"
$KUBECTL_PATH get pods -n $NAMESPACE | grep -E "NAME|moz-" | head -15

echo ""
echo "✅ Servicios encendidos"
echo "🌐 Hubs estará disponible en ~2 minutos en: https://meta-hubs.org"
echo "📊 Para ver estado completo: kubectl get pods -n hcce"
