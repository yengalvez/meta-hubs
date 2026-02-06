# YenHubs - Hubs CE 2.0.0 Custom Deployment

Custom deployment of [Hubs Foundation Community Edition](https://hubsfoundation.org/) on DigitalOcean Kubernetes.

## Features

- **Third-person camera** - Toggle between first and third person view ([docs](features/third-person/doc-thirdperson.md))
- **ReadyPlayer.me GLB avatars** - Pre-downloaded full-body avatars with validation ([docs](features/rpm-avatars/README.md))
- **Cost-optimized** - DigitalOcean deployment at ~$40-50/month

## Quick Start

See [deployment/README.md](deployment/README.md) for the full deployment guide.

```bash
# 1. Clone with submodules
git clone --recurse-submodules https://github.com/yengalvez/meta-hubs.git
cd meta-hubs

# 2. Configure
cp deployment/input-values.example.yaml hubs-cloud/community-edition/input-values.yaml
# Edit input-values.yaml with your domain, SMTP, etc.

# 3. Deploy
cd hubs-cloud/community-edition
npm install && npm run gen-hcce && kubectl apply -f hcce.yaml

# 4. SSL
npm run gen-ssl
```

## Project Structure

```
YenHubs/
├── hubs/               # Hubs client fork (submodule: yengalvez/hubs)
├── hubs-cloud/         # Official deploy scripts (submodule: Hubs-Foundation/hubs-cloud)
├── deployment/         # Deployment config, values template, and guide
├── features/
│   ├── third-person/   # Third-person camera implementation
│   ├── rpm-avatars/    # ReadyPlayer.me GLB avatar docs and validator
│   └── future/         # Features for potential future implementation
│       └── Avaturn/    # Avaturn avatar editor (not active)
└── docs/               # Project maintenance documentation
```

## Cost Estimate

| Resource | Monthly |
|----------|---------|
| DOKS Node (4GB) | $24 |
| Load Balancer | $12 |
| Storage | ~$2 |
| SMTP | $1-5 |
| **Total** | **~$40-48** |

## References

- [Official Hubs CE Guide](https://docs.hubsfoundation.org/beginners-guide-to-CE.html)
- [Hubs Foundation Docs](https://docs.hubsfoundation.org)
- [Hubs GitHub](https://github.com/Hubs-Foundation/hubs)
