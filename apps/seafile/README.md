# Seafile on LibrePod

## Prerequisites

- Kubernetes cluster with Traefik ingress controller
- Default StorageClass configured for persistent volumes
- Kubectl or similar tool configured for cluster access

## Deployment

```bash
kustomize build --enable-helm apps/seafile/overlays/librepod | kubectl apply -f -
```

## Access

- Web UI: https://seafile.libre.pod
- Default admin: admin@libre.pod / changeme_admin_password

## Security

**CRITICAL:** All passwords below are hardcoded in `base/values.yaml` and must be changed before production use.

### Application Credentials

| Credential | Default Value | Purpose | Location |
|------------|---------------|---------|----------|
| Admin Email | admin@libre.pod | Seafile admin account | `INIT_SEAFILE_ADMIN_EMAIL` |
| Admin Password | generated at install (stored in the OpenBao entry `apps/seafile`) | Seafile admin login | `INIT_SEAFILE_ADMIN_PASSWORD` |

### Database Credentials

| Credential | Default Value | Purpose | Location |
|------------|---------------|---------|----------|
| MySQL Root Password | changeme_root_password | MySQL root user | `DB_ROOT_PASS`, `mysql.auth.rootPassword` |
| MySQL User Password | changeme_db_password | Seafile database user | `SEAFILE_DB_PASSWORD`, `mysql.auth.password` |

### Cache Credentials

| Credential | Default Value | Purpose | Location |
|------------|---------------|---------|----------|
| Redis Password | changeme_redis_password | Redis authentication | `REDIS_PASSWORD`, `redis.auth.password` |

### Changing Passwords

1. Edit `apps/seafile/base/values.yaml`
2. Update all 5 password values listed above
3. Redeploy: `kustomize build --enable-helm apps/seafile/overlays/librepod | kubectl apply -f -`

## Data Persistence

- **Storage**: 10Gi PersistentVolumeClaim for Seafile data
- **StorageClass**: Uses cluster default (configured via `storageClassName: ""`)
- **Databases**: MySQL and Redis run as StatefulSets with their own PVCs
- **Backups**: Implement backup strategy for PVCs in production environment

## Architecture

This deployment bundles:
- **Seafile CE 13.0.0**: Primary file synchronization service
- **MySQL 14.0.3**: Database backend (Bitnami chart)
- **Redis 24.1.2**: Cache layer (Bitnami chart)

All services run in the `seafile` namespace with ClusterIP-type services, exposed via Traefik IngressRoute.
