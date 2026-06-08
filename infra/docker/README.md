# Docker

The primary local stack is defined in the **root `docker-compose.yml`**
(Postgres + Redis + Adminer):

```bash
docker compose up -d
docker compose ps
docker compose down        # add -v to delete data volumes
```

This folder is reserved for service-specific Dockerfiles and container assets as
they are added (e.g. API and AI-service images for staging). None are required
for Phase 1 local development.

> Docker is **not installed** on the current machine. The compose file and these
> docs are ready for when it is available.
