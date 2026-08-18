# The ShotIQ warm worker: one image, two processes.
#
# Built from the repository root, like the other two, so that a single
# .dockerignore governs every image:
#
#     docker build -f worker/Dockerfile -t shotiq-worker .
#
# The API and the job consumer ship in the SAME image and differ only in the
# command Compose gives them. Two images would have to be kept in step and
# could drift into running different code against the same queue -- which is
# the one thing that must never happen, because the producer and the consumer
# agree about the job payload only as long as they are the same build.
#
# Alpine here, where the API image is Debian, and the contrast is the point.
# That image needs glibc because pandas and numpy ship manylinux wheels musl
# cannot use. Nothing in this service has a compiled dependency -- Fastify,
# BullMQ, ioredis and pino are all plain JavaScript -- so musl costs nothing
# and the base image is ~50 MB instead of ~200 MB. "Alpine is smaller" is a
# reason only once you have checked what your dependencies actually need.

# --- build stage ---------------------------------------------------------

FROM node:22-alpine AS build

WORKDIR /app

# Manifests first, so installing dependencies is its own cached layer and
# editing a source file does not reinstall the tree.
COPY worker/package.json worker/package-lock.json ./

# npm ci rather than npm install: it installs exactly what the lockfile pins
# and fails if the lockfile disagrees with package.json, instead of quietly
# resolving something newer. A build should produce the same thing twice.
#
# The full tree including devDependencies, because TypeScript itself is a
# devDependency and this stage is where the compiler runs.
RUN npm ci

COPY worker/tsconfig.json worker/tsconfig.build.json ./
COPY worker/src ./src

# tsconfig.build.json, not tsconfig.json: it emits, and it excludes the tests
# and src/testing. The type ANNOTATIONS are erased here -- what lands in
# dist/ is plain JavaScript, and nothing in the runtime stage knows
# TypeScript was ever involved.
RUN npm run build

# --- runtime stage -------------------------------------------------------

FROM node:22-alpine AS runtime

# NODE_ENV=production is read by libraries, not by us: several skip
# development-only work when it is set, and npm treats it as a reason to
# omit devDependencies.
ENV NODE_ENV=production

WORKDIR /app

COPY worker/package.json worker/package-lock.json ./

# --omit=dev is what makes this stage worth having: TypeScript, Vitest and
# their trees stay in the build stage and never reach the image that runs.
# A production image containing no compiler and no test runner cannot be
# talked into using them.
RUN npm ci --omit=dev && npm cache clean --force

# Only the compiled output crosses the stage boundary. No .ts source, no
# tsconfig, no node_modules from the build stage.
COPY --from=build /app/dist ./dist

# The node images already ship a non-root `node` user, so there is no
# useradd here -- the API image creates one because python:3.12-slim does
# not. Containers run as root by default, which means a process escaping
# the container arrives as root on the host. Nothing here needs privileges.
USER node

EXPOSE 3001

# Checks the API's own health endpoint. wget is in busybox, already present
# in Alpine, so this costs no extra package.
#
# Only meaningful for the API process. The worker runs from this same image
# with a different command and has no HTTP surface at all, so Compose
# overrides its healthcheck rather than pretending this one applies.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:3001/health || exit 1

# The default command is the API. The worker process overrides it in
# docker-compose.yml with `node dist/worker/index.js`.
CMD ["node", "dist/index.js"]
