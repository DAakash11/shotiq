# ShotIQ

An interactive dashboard for exploring NBA shot data — distance, angle, defender pressure and shot-clock context — with an AI scouting note written only from the numbers on the page.

Opens on **Shai Gilgeous-Alexander, 2025-26**. Any player back to 1996-97 can be loaded from the UI.

**React · Python/FastAPI · TypeScript · Redis · Docker**

---

## What this project demonstrates

| | |
| --- | --- |
| **Frontend** | React 19 with hooks, CSS Modules, Recharts. Data fetching isolated in a service layer; chart maths in pure, unit-tested functions. |
| **Backend** | FastAPI on uvicorn, typed request models, a third-party API wrapped so exactly one module knows it exists. |
| **TypeScript** | A separate service in `strict` mode — discriminated unions, type guards, generics, and runtime schema validation at the HTTP boundary. |
| **Async / queues** | BullMQ on Redis: idempotent job submission, deduplication verified under concurrent load, state that survives a process restart. |
| **LLM integration** | Structured JSON output from Gemini, constrained to a server-computed digest so every figure traces back to the data. |
| **Docker** | Multi-stage frontend build, a private API reachable only over the compose network, health-gated startup. |
| **Testing** | 316 tests — 112 frontend, 121 Python, 83 in the TypeScript service — all enforced to run offline. |

Reasoning behind each decision is in the commit messages; they are written to explain *why*, not what changed.

---

## Quick start

No Node and no Python needed on the host:

```
docker compose up --build
```

Open **http://localhost:8080**.

That brings up five services: nginx serving the dashboard, the FastAPI backend, Redis, the job API and the worker that drains the queue. The job API's interactive docs are at **http://localhost:3001/docs**. Together they idle at about 150 MB.

Five seasons ship complete — shot data, tracking splits and the generated note — so a fresh clone works with **no API key and no network**:

| Player | Season | |
| --- | --- | --- |
| Shai Gilgeous-Alexander | 2025-26 | back-to-back MVP, the default subject |
| Nikola Jokić | 2021-22 | second straight MVP |
| Stephen Curry | 2016-17 | 768 attempts from 24+ feet |
| LeBron James | 2015-16 | the Cleveland title season |
| Luka Dončić | 2023-24 | scoring title |

Any other player works too, but needs a live fetch from `stats.nba.com`.

## Run locally

**API** — first terminal:

```
cd server
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

On macOS or Linux the venv binary is `.venv/bin/python`. Interactive docs at http://localhost:8000/docs.

**Frontend** — second terminal:

```
npm install
npm run dev
```

Vite serves http://localhost:5173 and proxies `/api` to the Python service.

**Warm worker** — optional, two more terminals. It runs as two processes from one codebase: an API that accepts jobs, and a worker that executes them.

```
docker run -d --name shotiq-redis -p 6379:6379 redis:alpine
cd worker
npm install && npm run build

npm start           # job API on 3001
npm run start:worker    # the consumer, in a second terminal
```

Interactive docs at http://localhost:3001/docs. Submit a job there, then poll `GET /api/jobs/{id}` and watch it move from `queued` to `completed` with a result attached.

**Generating new AI notes** is optional — the five seasons above are committed and work with no setup. For a different player, put a free [Google AI Studio](https://aistudio.google.com/apikey) key in `server/.env` as `GEMINI_API_KEY` and set `SHOTIQ_SUMMARY_LIVE=true`. That flag defaults to false and only the exact word `true` enables it, so a deployment that sets nothing cannot spend quota.

---

## Layout

```
src/
  components/   presentational React components
  hooks/        reusable stateful logic
  services/     the only place that calls fetch
  utils/        pure data logic — sorting, chart aggregation
server/         FastAPI service + cached NBA data
worker/         TypeScript job service that pre-warms the cache
```

`web` (nginx, port 8080) and the job API (3001) are the only published services. `api` and `redis` are reachable solely over the compose network — the browser calls `/api/...` with no host in the path, so nothing in the bundle knows where the API lives, and an unauthenticated Redis is never exposed to the host.

The job API and the worker are the **same image with different commands**. Two images would have to be kept in step and could drift into running different code against one queue, which is the one thing that must not happen: producer and consumer agree about the job payload only as long as they are the same build.

### The warm worker

A standalone TypeScript service that queues the slow parts of a lookup — the fetch from `stats.nba.com`, which can take 90 seconds, and the metered LLM call — so the dashboard does not wait on them. It calls the existing API rather than reimplementing any analytics.

`POST /api/jobs` returns **202** for new work and **200 with `deduplicated: true`** for a repeat, because the job id is derived from the player and season (`warm:201939:2016-17`), so duplicates collide by construction. Jobs live in Redis, so they outlive the process that created them.

## API

| Endpoint | Contents |
| --- | --- |
| `GET /api/shots?playerId=&season=` | One record per attempt — distance, angle, coordinates, period, clock, zone, make/miss. Plus league-average FG% by zone. |
| `GET /api/splits?playerId=&season=` | Defender distance, shot clock, dribbles, touch time. Empty before 2013-14. |
| `GET /api/players?q=` | Name search, offline. |
| `GET /api/seasons` | Selectable seasons, flagged for tracking availability. |
| `POST /api/summary` | The AI scouting note. |
| `GET /api/health` | Liveness. |

Responses are cached to `server/cache/` by player and season; add `?refresh=true` to force a refetch.

## Tests

```
npm test                      # frontend — 112 tests

cd worker
npm test                      # unit — 67 tests, no Redis needed
npm run test:integration      # 16 tests against a real Redis

cd server
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest   # 121 tests
```

**Everything runs offline, and that is enforced rather than trusted.** The NBA fetchers raise under a fixture, constructing a real LLM client raises, and the live-generation flag is pinned off regardless of what sits in a developer's `.env`. The TypeScript service replaces `fetch` with a guard that both rejects and *records* the attempt — recording matters, because its HTTP client catches every network failure and wraps it, so a throw alone would be swallowed and a test could pass having gone out to the internet. The worker's integration tests are the one exception and are kept separate: they need a real Redis and **fail** if one is absent, rather than skipping — a suite that goes green where nothing was verified is worse than one that will not run.

## Deployment

ShotIQ runs on Google Kubernetes Engine, on infrastructure defined entirely in
Terraform and deployed by GitHub Actions.

The cluster is created and destroyed on demand rather than left running — it is
a portfolio demo on trial credit, not a service with users, so the interesting
property is that `terraform apply` reproduces the whole environment from an
empty project in one command.

### Prerequisites

| Tool | Version used | Purpose |
| --- | --- | --- |
| [gcloud CLI](https://cloud.google.com/sdk/docs/install) | 581.0.0 | authenticating to GCP, inspecting the project |
| [Terraform](https://developer.hashicorp.com/terraform/install) | 1.11.4 | provisioning the cluster, network and registry |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | 1.30.2 | applying manifests, inspecting the running cluster |
| Docker | 27.2.0 | building the images the cluster runs |

Plus a GCP project with billing enabled, and these APIs turned on:

```
gcloud services enable \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  compute.googleapis.com container.googleapis.com \
  artifactregistry.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com \
  storage.googleapis.com monitoring.googleapis.com logging.googleapis.com
```

(A new GCP project ships with almost every API disabled.)

### Authentication

Two logins, and both are needed:

```
gcloud auth login                      # credential for the gcloud tool itself
gcloud auth application-default login  # Application Default Credentials, read by Terraform
```

The second writes the credential *client libraries* look for, and the Terraform
Google provider is one. Without it `gcloud` works while `terraform plan` fails
claiming it cannot find default credentials.

### Infrastructure

Everything GCP-side is declared in [`terraform/`](terraform/) and nothing is
clicked in the console. The console is fine for looking; a resource created
there exists only in that project and in whoever's memory, and it will still
be billing next month.

```
cd terraform
cp terraform.tfvars.example terraform.tfvars   # then set project_id
terraform init                                 # download providers, write the lock file
terraform plan                                 # show what would change; changes nothing
terraform apply                                # make it so
```

| File | Holds |
| --- | --- |
| `versions.tf` | Terraform and provider version constraints |
| `variables.tf` | input declarations, with validation |
| `main.tf` | provider config and resources |
| `outputs.tf` | values published for scripts and CI to consume |
| `network.tf` | VPC and the subnet the cluster runs in |
| `registry.tf` | Artifact Registry repo, with cleanup policies |
| `terraform.tfvars` | this environment's values — **gitignored** |

The subnet is **VPC-native**: a primary range for nodes plus secondary ranges
for pods and services, so every pod holds a real routable VPC address rather
than a port mapped onto its host. GKE allocates a whole `/24` of pod space per
node, so the pod range is sized in nodes — the `/20` here allows sixteen,
against a cluster capped at three.

No `credentials` argument appears on the provider, so it uses Application
Default Credentials: a developer's own login locally, a federated identity in
CI. The same files authenticate in both places because neither is named in them.

The registry carries cleanup policies — untagged versions deleted after seven
days, five most recent kept regardless. Registry storage is billed per GB-month
and survives a cluster teardown, so an unbounded registry is the line item that
outlives everything else.

## Acknowledgements

Shot data from `stats.nba.com` via [`nba_api`](https://github.com/swar/nba_api).

Built as a pair-programming exercise with Claude (Anthropic). The reasoning behind each architectural decision is recorded in the commit history.
