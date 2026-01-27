#!/bin/bash

# Deployment Script for Hubs CE on DigitalOcean
# Usage: ./deploy.sh
echo "Starting deployment process for Meta Hubs..."

# Variables
NAMESPACE="hubs"

# Check for kubectl
if ! command -v kubectl &> /dev/null; then
    echo "kubectl could not be found. Please install it."
    exit 1
fi

echo "Verifying Cluster Access..."
if ! kubectl get nodes; then
    echo "Cannot connect to cluster. Ensure ~/.kube/config is set."
    exit 1
fi

echo "Deploying/Upgrading Hubs CE..."
# Add Mozilla Helm Repo if not present
helm repo add mozilla https://mozilla.github.io/hubs-cloud-helm-charts/
helm repo update

# Install/Upgrade
# We rely on existing values.yaml
helm upgrade --install hubs mozilla/hubs \
    -f ./hubs-ce-deployment/values.yaml \
    --namespace $NAMESPACE \
    --create-namespace \
    --set global.domain="meta-hubs.org"

echo "Deployment command executed."
echo "Wait for pods to be ready: kubectl get pods -n $NAMESPACE -w"
