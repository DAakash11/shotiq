# The ShotIQ frontend: React built by Node, served by nginx.
#
#     docker build -t shotiq-web .
#
# Multi-stage, and the reason is the whole point of the pattern. Building
# the app needs Node, npm and ~110 MB of node_modules; SERVING it needs a
# web server and a directory of static files. Those are different jobs, so
# they are different images. Everything in the build stage is discarded --
# only the dist/ directory crosses into the final image, which means no
# Node, no npm, no source, and no dependency tree in what actually runs.

# --- build stage ---------------------------------------------------------

FROM node:22-alpine AS build

WORKDIR /app

# Manifests first, so the dependency install is its own cached layer.
# Editing a component then rebuilds in seconds instead of reinstalling
# every package.
COPY package.json package-lock.json ./

# npm ci, not npm install: it installs exactly what package-lock.json
# pins and fails if the lockfile disagrees with package.json, rather than
# quietly resolving something newer. A build should be reproducible.
RUN npm ci

# Only what Vite actually reads. Copying the whole context would mean a
# change to a Python file invalidated this layer and rebuilt the frontend
# for no reason.
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src

RUN npm run build

# --- runtime stage -------------------------------------------------------

FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# wget is already in the nginx:alpine image (busybox), so checking that the
# server answers costs nothing extra.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1
