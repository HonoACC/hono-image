# Hono Image Lab

Independent image-generation workbench for OpenAI-compatible image APIs.

The app follows the same high-level pattern as LobeChat image generation:

- browser submits a short local task request
- local Node task server runs the long image request in the background
- browser polls local task status
- generated base64 images are cached under `.hono-image-cache`

API keys are entered in the browser UI and forwarded as request headers. They are not written to project files.

## Local Development

Run the task API:

```bash
npm run dev:api
```

Run the Vite frontend:

```bash
npm run dev -- --host 127.0.0.1 --port 5188
```

Open:

```text
http://127.0.0.1:5188/
```

## Production Docker

The Docker image serves both the built frontend and the task API from one Node process on port `5190`.

Deploy on a server:

```bash
mkdir -p ~/hono-image
cd ~/hono-image
curl -fsSLO https://raw.githubusercontent.com/HonoACC/hono-image/main/docker-compose.yml
docker compose pull
docker compose up -d
```

Upgrade after a new GitHub Actions build:

```bash
cd ~/hono-image
docker compose pull
docker compose up -d
```

Check container logs:

```bash
docker compose logs -f hono-image
```

If the GHCR package is changed to private, log in before pulling:

```bash
echo 'YOUR_GITHUB_PAT' | docker login ghcr.io -u HonoACC --password-stdin
```

Run from a local checkout:

```bash
docker compose up -d
```

Open:

```text
http://SERVER_IP:5190/
```

The default image in `docker-compose.yml` is:

```text
ghcr.io/honoacc/hono-image:latest
```

If you publish under another GitHub owner or repo, update the image name before deploying.

## Validation

```bash
npm run build
npm run lint
node --check server/image-task-server.mjs
```
