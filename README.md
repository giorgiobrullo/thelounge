<h1 align="center">
  <img
    width="300"
    alt="The Lounge"
    src="https://raw.githubusercontent.com/thelounge/thelounge/master/client/img/logo-vertical-transparent-bg.svg?sanitize=true">
</h1>

<p align="center">
  <a href="https://github.com/giorgiobrullo/thelounge/pkgs/container/thelounge"><img src="https://img.shields.io/badge/ghcr.io-Docker_Image-blue?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"></a>
  <a href="https://github.com/thelounge/thelounge"><img src="https://img.shields.io/badge/Upstream-thelounge%2Fthelounge-333a41?style=for-the-badge&logo=github&logoColor=white" alt="Upstream"></a>
  <a href="https://github.com/giorgiobrullo/thelounge/actions/workflows/docker.yml"><img src="https://img.shields.io/github/actions/workflow/status/giorgiobrullo/thelounge/docker.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=Build" alt="Build Status"></a>
  <a href="https://github.com/giorgiobrullo/thelounge/commits/master"><img src="https://img.shields.io/github/last-commit/giorgiobrullo/thelounge?style=for-the-badge&logo=github&logoColor=white&label=Last%20Built" alt="Last Built"></a>
</p>

<p align="center">
  Personal fork of <a href="https://thelounge.chat/">The Lounge</a>, a modern self-hosted web IRC client.
</p>

## About

This is a personal fork where I maintain Docker images with up-to-date dependencies and base layers, occasionally cherry-pick unmerged PRs I find useful, and fix build issues as they come up (like the webpack/tsc parallel build race condition that was silently dropping `dist/shared/types/`).

## Docker
```bash
docker pull ghcr.io/giorgiobrullo/thelounge:latest
```

### Simple setup
```yaml
services:
  thelounge:
    image: ghcr.io/giorgiobrullo/thelounge:latest
    volumes:
      - /path/to/.thelounge:/var/opt/thelounge
    ports:
      - 9000:9000
    restart: on-failure
```

### With Traefik v3
```yaml
services:
  traefik:
    image: traefik:v3.6
    restart: always
    command:
      - "--providers.docker=true"
      - "--providers.docker.network=traefik"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entryPoint.to=websecure"
      - "--entrypoints.web.http.redirections.entryPoint.scheme=https"
      - "--entrypoints.web.http.redirections.entryPoint.permanent=true"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.default.acme.tlschallenge=true"
      - "--certificatesresolvers.default.acme.email=you@example.com"
      - "--certificatesresolvers.default.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - letsencrypt:/letsencrypt
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik

  thelounge:
    image: ghcr.io/giorgiobrullo/thelounge:latest
    volumes:
      - /path/to/.thelounge:/var/opt/thelounge
    restart: on-failure
    expose:
      - 9000
    networks:
      - traefik
    labels:
      - traefik.enable=true
      - traefik.http.routers.thelounge.entrypoints=websecure
      - traefik.http.routers.thelounge.rule=Host(`irc.example.com`)
      - traefik.http.routers.thelounge.tls=true
      - traefik.http.routers.thelounge.tls.certResolver=default
      - traefik.http.services.thelounge.loadbalancer.server.port=9000

volumes:
  letsencrypt:

networks:
  traefik:
    external: true
```

## Upstream

All credit goes to the original [The Lounge](https://github.com/thelounge/thelounge) team. This fork tracks upstream `master` and rebases on top.

## License

[MIT](LICENSE) — same as upstream.
