# The ShotIQ API.
#
# Built from the repository root, not from server/, so that one
# .dockerignore governs both images:
#
#     docker build -f server/Dockerfile -t shotiq-api .
#
# Debian slim rather than Alpine, and that is the decision worth
# understanding here. nba_api depends on pandas and numpy, which are
# compiled C extensions. Alpine uses musl libc, so it cannot use the
# prebuilt manylinux wheels published on PyPI and pip falls back to
# building both from source -- a toolchain, and many minutes, to arrive at
# the same thing Debian installs in seconds. "Alpine is smaller" is true
# and beside the point when the package you need ships glibc wheels.

FROM python:3.12-slim

# PYTHONDONTWRITEBYTECODE: .pyc files help across process restarts, and a
# container is a fresh filesystem every time, so they are pure bloat here.
# PYTHONUNBUFFERED: without it Python buffers stdout when it is a pipe
# rather than a terminal, and `docker logs` shows nothing until the buffer
# fills -- which looks exactly like a hung service.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, in their own layer. Docker caches each instruction
# against the checksum of its inputs, so keeping this above the source copy
# means editing a .py file reuses the installed packages instead of
# reinstalling pandas on every build. Copying everything first would throw
# that cache away on every code change.
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Source, plus the committed cache. requirements-dev.txt and tests/ are
# excluded by .dockerignore, so the production image ships no test runner.
COPY server/ ./

# Run as a normal user. Containers run as root by default, which means a
# process escaping the container arrives as root on the host. Nothing here
# needs privileges: the port is 8000, and only ports below 1024 are
# restricted.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Uses the API's own health endpoint, which never touches stats.nba.com.
# urllib rather than curl, so the image does not grow a package purely to
# check itself.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"

# --host 0.0.0.0 is mandatory, not stylistic. uvicorn defaults to 127.0.0.1,
# which inside a container means the container's own loopback: the port
# would be published and every connection refused. No --reload either --
# it watches the filesystem and restarts, which belongs in development.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
