# Fragments

[![ci](https://github.com/AjayMaan13/fragments/actions/workflows/ci.yml/badge.svg)](https://github.com/AjayMaan13/fragments/actions/workflows/ci.yml)

A cloud-native microservice for storing, converting, and sharing small pieces of data ("fragments") — text, JSON, XML, and images — with authenticated multi-user access. It runs as a containerized service on AWS Fargate, and **the entire environment is defined in Terraform**, so it can be created or destroyed with one command.

Every push runs a full test suite; every version tag builds a Docker image and rolls it out to AWS through GitHub Actions, authenticated with OIDC (no stored AWS keys).

**Demo video:** https://youtu.be/YJZaokns0F0
**Deployment:** on demand — created with `terraform apply` and torn down when not in use (see [Deploying to AWS](#deploying-to-aws)); the API's URL is printed by `terraform output api_url`
**Companion UI:** [fragments-ui](https://github.com/AjayMaan13/fragments-ui)

---

## What it does

- Authenticated users create, read, update, and delete fragments through a REST API
- Stores 12 content types: `text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/yaml`, `application/xml`, and 5 image formats (`png`, `jpeg`, `webp`, `avif`, `gif`)
- **Converts on read** — 35 conversion paths, requested with a URL extension, without ever storing a second copy:
  markdown → HTML · JSON ↔ YAML · JSON ↔ XML · CSV → JSON · image ↔ image (via `sharp`) · markdown / plain text → **PDF** and **Word (.docx)**
- **Expiring fragments** (`?expiresIn=<seconds>`): they vanish from reads and lists immediately; DynamoDB TTL and a Lambda then delete the stored data from S3
- **View counts**, incremented atomically in DynamoDB
- **Temporary public share links** — pre-signed S3 URLs, capped at 1 hour and at the fragment's own expiry
- **Image thumbnails** on the fly (`?width=<pixels>`)
- **Background conversions** — heavy conversions run as jobs on a separate worker over SQS (`POST /v1/fragments/:id/jobs`), so they can't starve the API ([details](#async-conversions))
- **Semantic search** — find your text fragments by meaning with Bedrock embeddings (`GET /v1/search`, [details](#semantic-search))
- Two swappable backends, chosen purely by environment variables:
  - **Auth:** HTTP Basic (local dev) or Amazon Cognito (production)
  - **Storage:** in-memory (local dev) or Amazon S3 + DynamoDB (production)

## Architecture

```mermaid
flowchart TB
    User([User]) --> UI["fragments-ui<br/>browser app"]
    Anyone([Anyone with<br/>a share link])
    UI -- "OAuth login" --> Cognito["Amazon Cognito<br/>login + user pool"]
    UI -- "REST + bearer token" --> ALB

    subgraph AWS["AWS · us-east-2"]
        ALB["Application<br/>Load Balancer"] --> API["ECS Fargate<br/>fragments API"]
        ECR[("ECR<br/>images")] -. "image" .-> API
        API -- "data" --> S3[("S3<br/>fragment data")]
        API -- "metadata, views" --> DDB[("DynamoDB<br/>metadata · views · TTL")]
        API -- "logs" --> CW["CloudWatch<br/>Logs"]
        DDB -- "TTL delete<br/>(stream)" --> Lambda["Lambda<br/>expiry cleanup"]
        Lambda -- "delete object" --> S3
    end

    API -. "verify token" .-> Cognito
    Anyone -. "pre-signed URL<br/>(expires)" .-> S3
```

### Delivery pipeline

Terraform owns the infrastructure and the task definition's settings; CI/CD only ships new images.

```mermaid
flowchart TB
    Dev([Developer])

    subgraph GH["GitHub Actions"]
        CI["<b>ci</b> · every push and PR<br/>lint · unit + integration tests<br/>terraform validate"] --> Hub["Docker Hub<br/>image push"]
        CD["<b>cd</b> · every v* tag<br/>build image, push to ECR<br/>deploy to ECS"]
        Hub ~~~ CD
    end

    TF["<b>Terraform</b> · infra/<br/>9 modules · 34 resources"]

    subgraph AWS["AWS"]
        Role["IAM deploy role<br/>OIDC · least privilege"]
        ECR[("ECR")]
        Svc["ECS service<br/>rolling deployment"]
        Role ~~~ ECR ~~~ Svc
    end

    Dev -- "git push" --> CI
    Dev -- "git tag v*" --> CD
    Dev -- "terraform apply / destroy" --> TF
    TF -. "provisions" .-> AWS
    CD -- "OIDC token<br/>(no stored keys)" --> Role
    CD -- "push image" --> ECR
    CD -- "update service" --> Svc
```

### Life of an expiring fragment

```mermaid
%%{init: {"sequence": {"width": 110, "actorMargin": 40, "messageMargin": 28}}}%%
sequenceDiagram
    actor U as User
    participant A as API
    participant D as DynamoDB
    participant S as S3
    participant L as Lambda

    U->>A: create (expiresIn=3600)
    A->>D: metadata + expiresAt
    A->>S: data
    U->>A: read
    A->>D: add 1 view
    A-->>U: data
    Note over A,D: after expiresAt, reads return 404
    D->>D: TTL deletes record (~48 h)
    D-->>L: stream event (TTL only)
    L->>S: delete the object
```

## AWS services used

| Service | Role |
|---|---|
| **ECS (Fargate)** | Serverless container orchestration — runs the API with no managed EC2 instances |
| **ECR** | Private Docker image registry, pulled by ECS on deploy |
| **Elastic Load Balancing (ALB)** | Public entry point, routes traffic to healthy ECS tasks (HTTP; HTTPS is not enabled) |
| **S3** | Stores fragment data; public access blocked, shared only through expiring pre-signed URLs |
| **DynamoDB** | Fragment metadata (id, type, size, timestamps, view count, expiry), on-demand billing; TTL expires fragments and a stream reports the deletions |
| **Lambda** | Deletes an expired fragment's data from S3 when DynamoDB's TTL removes its record |
| **Cognito** | User authentication via OAuth 2.0 / OIDC hosted login; JWT bearer tokens verified server-side |
| **IAM** | Least-privilege task and execution roles, plus a GitHub OIDC deploy role so CI needs no stored AWS keys |
| **CloudWatch Logs** | Centralized structured logging (Pino JSON) from every container and the Lambda |
| **VPC** | Default VPC; security groups let only the load balancer reach the containers |

## Tech stack

- **Runtime:** Node.js, Express
- **Auth:** Passport (HTTP Basic + Bearer/Cognito JWT strategies), `aws-jwt-verify`
- **Data:** `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/s3-request-presigner`
- **Conversions:** `sharp` (image transcoding and resizing via libvips), `js-yaml`, `csvtojson`, `markdown-it`, `fast-xml-parser` (XML), `pdfkit` (PDF), `docx` (Word)
- **Infrastructure:** Terraform (9 modules)
- **Logging:** Pino (structured JSON logs, pretty-printed locally)
- **Security:** Helmet (security headers), CORS
- **Testing:** Jest (unit), Hurl (HTTP integration), Docker Compose with DynamoDB Local + MiniStack (S3-compatible mock) for local AWS-parity testing
- **CI/CD:** GitHub Actions — lint, Dockerfile lint (hadolint), unit and integration tests, Terraform format/validate, Docker Hub publish on every push to `main`; on every version tag, an ECR publish and rolling ECS deployment authenticated with GitHub OIDC
- **Containerization:** Multi-stage Dockerfile, production dependencies only in the final image

## Engineering highlights

Measured, with the commands and raw numbers in [`docs/`](docs/):

- **Found and fixed real failures by load testing** ([`docs/perf/baseline.md`](docs/perf/baseline.md)). With k6 against the deployed 0.25 vCPU task: it is CPU-bound at about 100 req/s; one 758 KiB PNG that decodes to 256 megapixels killed the container with a single request; and a mix with 20% conversions took cheap-read p95 from 63 ms to over 60 s with 39% of requests failing. Fixed with an image pixel limit (422) and a cap on concurrent conversions.
- **Async pipeline, measured before and after** ([`docs/perf/async.md`](docs/perf/async.md)). Moving conversions to an SQS worker (dead-letter queue, conditional DynamoDB writes, leases) took the same load to cheap-read p95 **67 ms with 0 of 3,712 requests failing**. The honest remainder: one 0.5 vCPU worker finishes one AVIF per ~19 s, and small jobs queue behind heavy ones.
- **Mutation testing, not just coverage** ([`docs/mutation/`](docs/mutation/README.md)). Line coverage was 96% while only 76.4% of mutants were caught; adding 234 targeted tests raised it to **98.6%** (95.1% on GitHub's weekly run, which also covers the search code), and found a real bug (a failed resize returned its error labelled as an image).
- **Observability** ([`docs/observability.md`](docs/observability.md)). A CloudWatch dashboard, six alarms and custom metrics, all Terraform; request IDs flow from the API into the worker's logs. Load tests showed the first 5xx alarm missed load-balancer-generated errors; fixed and seen firing.
- **Semantic search on Bedrock** ([`docs/search.md`](docs/search.md)). Titan embeddings at 256 dimensions, indexed in the background, scoped to the caller. Verified on the deployed stack: paraphrased queries found the right note and another user saw nothing; on a small author-written evaluation recall@1 was 1.00 against 0.44 for a keyword baseline.
- **End-to-end UI tests** in [fragments-ui](https://github.com/AjayMaan13/fragments-ui): 35 Playwright tests in CI with no AWS or backend, plus a manual live test against real Cognito.

And the foundations:

- **97.96% line test coverage, enforced in CI (80% minimum)** — 608 unit tests plus 20 Hurl integration test files covering every route, every conversion path, and both success and error cases
- **Everything as code** — every AWS resource is defined in Terraform, so the whole environment can be created, or destroyed to stop billing, with one command; CI/CD only ships images
- **No long-lived credentials in CI** — GitHub Actions assumes a least-privilege IAM role through OIDC, limited to this repository's version tags
- **Least-privilege IAM** — the running container can touch only its own S3 bucket and DynamoDB table, and only with the operations the code uses
- **Zero-downtime rolling deployments** — pushing a tag builds an image and deploys a new ECS task revision while the old one keeps serving until the new one is healthy
- **Environment-driven configuration** — the identical codebase runs against an in-memory store locally and real AWS in production, switched only by which environment variables are present
- **Content-negotiated conversions** — one stored fragment can be requested back in any compatible format via a URL extension (`.html`, `.yaml`, `.pdf`, `.docx`, `.jpg`, …), computed on the fly
- **Atomic counters and self-cleaning data** — view counts use DynamoDB's atomic `ADD`; expiry is enforced on read and cleaned up asynchronously through a DynamoDB stream and Lambda

## API overview

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Health check (includes server hostname, useful for verifying load balancing) |
| `POST` | `/v1/fragments` | Create a new fragment (`?expiresIn=<seconds>` makes it expire, up to 30 days) |
| `GET` | `/v1/fragments` | List the authenticated user's fragments (`?expand=1` for full metadata) |
| `GET` | `/v1/fragments/:id` | Get a fragment's raw data |
| `GET` | `/v1/fragments/:id.ext` | Get a fragment converted to another supported format (`.html`, `.txt`, `.yaml`, `.json`, `.xml`, `.pdf`, `.docx`, image extensions) |
| `GET` | `/v1/fragments/:id/info` | Get a fragment's metadata only (includes `viewCount` and `expiresAt`) |
| `GET` | `/v1/fragments/:id/share` | Get a temporary public link to the fragment's data (`?expiresIn=<seconds>`, default 15 min, max 1 hour) |
| `POST` | `/v1/fragments/:id/jobs` | Convert in the background: body `{"to": ".avif", "width": 800}`. Answers `202` with a `Location` to poll (see [Async conversions](#async-conversions)) |
| `GET` | `/v1/search?q=...&k=5` | Semantic search over your text fragments (plain text, markdown, HTML), best match first, with a snippet (see [Semantic search](#semantic-search)) |
| `GET` | `/v1/jobs/:jobId` | A job's status (`queued`, `running`, `succeeded`, `failed`), attempts, and a download link when done |
| `PUT` | `/v1/fragments/:id` | Replace a fragment's data (its type is immutable) |
| `DELETE` | `/v1/fragments/:id` | Delete a fragment |

Image fragments accept `?width=<pixels>` on reads (with or without an extension) to return a smaller copy, e.g. `/v1/fragments/:id.webp?width=200`.

All `/v1/*` routes require authentication (HTTP Basic locally, or a Cognito bearer token in production).

### Semantic search

`GET /v1/search?q=<text>&k=<1-20>` finds a user's text fragments **by meaning**, not by shared words: "my pet cat stopped eating" finds a note about cat health that never uses those words.

- **Indexing is a background job.** Creating or updating a text fragment queues an `embed` message on the same SQS queue the conversion jobs use. The worker splits the text into overlapping chunks of about 900 characters, embeds each with **Amazon Bedrock Titan Text Embeddings V2** (256 dimensions, normalised) and stores them in their own DynamoDB table. A message for an out-of-date version is skipped; deleting a fragment removes its chunks.
- **No stored credentials.** Bedrock is called with the task's IAM role, allowed to invoke only that one model.
- **Search is brute force, on purpose.** The API embeds the query, scores the user's chunks by dot product (the vectors are normalised, so that is cosine similarity), keeps the best chunk per fragment, and returns the top `k`. It only ever reads the caller's own chunks. That is fine up to a few thousand chunks per user. Beyond that you would use a real vector index (OpenSearch Serverless, pgvector), which costs money while idle and so conflicts with the apply-and-destroy workflow.
- **Memory mode** answers `501`. Locally, docker compose uses a deterministic fake embedder so the plumbing runs with no AWS.
- **Measured:** on a 30-document, 25-query evaluation Titan scored recall@1 of 1.00 against 0.44 for a keyword-overlap baseline. It is an easy benchmark, written by the author; read [`docs/search.md`](docs/search.md) before quoting it.

### Async conversions

Converting inside the request is fine for small things, but some conversions are slow: a 1080p JPEG to AVIF took about 33 s of CPU on the 0.25 vCPU API task, and under load that starved every other request (see `docs/perf/baseline.md`). So there is also a background path:

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API task
    participant J as Jobs table (DynamoDB)
    participant Q as SQS queue
    participant W as Worker task
    participant S as S3
    C->>A: POST /v1/fragments/:id/jobs {"to": ".avif"}
    A->>J: create job (queued)
    A->>Q: send {jobId, ownerId} + request id
    A-->>C: 202 + Location /v1/jobs/:jobId
    W->>Q: long-poll receive
    W->>J: claim (queued to running, with a lease)
    W->>S: read fragment, write results/<owner>/<job>
    W->>J: finish (succeeded)
    W->>Q: delete message
    C->>A: GET /v1/jobs/:jobId
    A-->>C: succeeded + pre-signed result link (1 hour)
```

- **At-least-once, but one result.** SQS can deliver a message twice. Every state change is a conditional write in DynamoDB: a finished job can't be claimed again, and a worker whose lease ran out can't overwrite the worker that took over.
- **Worker dies mid-job:** the message reappears after the queue's visibility timeout (120 s) and another attempt claims the job. Locally, killing the worker mid-conversion gave attempt 2 exactly 120 s later and one success.
- **Failures:** an error retrying can't fix (image over the pixel limit, fragment deleted) fails the job immediately with the reason. Other errors retry with backoff; after 3 attempts the job is `failed`. Messages that still can't be handled land in the dead-letter queue, which has an alarm.
- **Jobs belong to their creator.** Someone else's job id answers `404`, same as a missing one. Job records and results are deleted after a day.
- **Not available in memory mode** (no queue): `POST` answers `501`.
- The existing synchronous `GET /v1/fragments/:id.ext` routes are unchanged.

## Design notes and limitations

- **HTTP only.** The load balancer serves plain HTTP; there is no custom domain or TLS certificate. Adding HTTPS would mean a domain plus an ACM certificate, or CloudFront in front.
- **Expiry is enforced on read.** DynamoDB's TTL can take up to about 48 hours to delete a record, so the API treats an expired fragment as missing immediately; the S3 data is then removed by the cleanup Lambda.
- **Share links are capped at 1 hour.** They are signed with the task role's temporary credentials, which rotate. Shared reads go straight to S3, so they are not counted as views.
- **PDFs are Latin-text only.** The built-in PDF fonts cover Latin characters; other scripts and emoji do not render. Bold, italics, and links in markdown are flattened to plain text.
- **Image conversion is bounded, and heavy work belongs in a job.** Images over 16 megapixels are refused with `422`, and at most 2 image conversions run at once (extra requests get `503` + `Retry-After`). A single 1080p JPEG to AVIF conversion takes about 33 s on the 0.25 vCPU task, so heavy conversions are not a good fit for the synchronous API.
- **PDF and Word are output formats.** They can be produced from markdown or plain text, but not uploaded as fragments.
- **On-demand deployment.** The load balancer and Fargate task cost money while running, so the intended workflow is `terraform apply` to work and `terraform destroy -target=module.ecs -target=module.alb` when done (this also removes the worker service, which runs in the same cluster).

## Repository layout

```
src/                 Express API (routes, model, auth, data backends, conversions)
                     worker.js + worker-core.js: the queue worker (same image)
tests/unit/          Jest unit tests          tests/integration/   Hurl HTTP tests
infra/               Terraform: root config + 12 modules (network, alb, ecs, ecr, iam,
                     storage, auth, events (Lambda), cicd (GitHub OIDC role),
                     observability (dashboard, alarms), queue (SQS + dead-letter
                     queue), worker (second ECS service))
src/search/          chunking, embeddings (Bedrock), vector maths, index and search
eval/                search quality evaluation (corpus, labelled queries, results)
perf/                k6 load tests (smoke + mixed-load staircase), see perf/README.md
.github/workflows/   ci.yml (tests, lint, terraform validate) and cd.yml (deploy on tag)
docs/                observability.md, perf/ (load-test results), UPGRADE_PLAN.md
```

---

## Deploying to AWS

All infrastructure is defined in `infra/` (Terraform); CI/CD only ships new images. To stand it up in a fresh AWS account:

1. Install [Terraform](https://developer.hashicorp.com/terraform/install) and run `aws configure` for the target account.
2. `cd infra && terraform init && terraform apply` — creates ECR, S3, DynamoDB (with TTL, a stream and a cleanup Lambda), Cognito, the load balancer, an ECS service (0 tasks for now) and the GitHub deploy role.
3. In the GitHub repo, add an Actions **variable** `AWS_DEPLOY_ROLE_ARN` set to `terraform output github_deploy_role_arn`.
4. Push a version tag (`npm version patch && git push --follow-tags`). The `cd` workflow builds and pushes the image to ECR and deploys it.
5. `terraform apply -var desired_count=1 -var worker_desired_count=1` starts the API and the queue worker (the async jobs API needs the worker). Copy `api_url` and the Cognito values from `terraform output` into `fragments-ui/.env`.

To stop billing, `terraform destroy -target=module.ecs -target=module.alb` removes only the load balancer and service, plus the dashboard and alarms that depend on them (data and users are kept); `terraform destroy` removes everything.

---

## Local Development

### Prerequisites

- [Node.js](https://nodejs.org/en) (LTS version)
- npm (comes with Node.js)
- [Docker](https://www.docker.com/) (for running the full stack with AWS-compatible mocks)

### Setup

```sh
npm install
```

### Running the server

```sh
npm start          # production mode
npm run dev         # auto-restarts on file changes
npm run debug        # with the Node debugger attached
```

By default the server runs on **http://localhost:8080**. Check it's running:

```sh
curl -s localhost:8080 | jq
```

```json
{
  "status": "ok",
  "description": "fragments service running normally",
  "author": "Ajaypartap Singh Maan",
  "githubUrl": "https://github.com/AjayMaan13/fragments",
  "version": "0.8.0",
  "timestamp": "...",
  "hostname": "..."
}
```

### Running the full local stack (S3 + DynamoDB mocks)

```sh
docker compose up --build -d
./scripts/local-aws-setup.sh
```

This starts the API alongside `dynamodb-local` and `MiniStack` (an S3-compatible mock), giving you AWS-parity behavior without touching real AWS resources.

### Testing

```sh
npm run lint            # ESLint
npm test                # Jest unit tests
npm run coverage         # Jest with coverage report
npm run test:integration  # Hurl integration tests (requires the Docker Compose stack running)
```

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default `8080`) |
| `NODE_ENV` | `production` disables HTTP Basic Auth |
| `HTPASSWD_FILE` | Enables HTTP Basic Auth (dev only, mutually exclusive with Cognito vars) |
| `AWS_COGNITO_POOL_ID` / `AWS_COGNITO_CLIENT_ID` | Enables Cognito auth |
| `AWS_REGION` | If set, switches the data layer from in-memory to S3/DynamoDB |
| `AWS_S3_BUCKET_NAME` / `AWS_DYNAMODB_TABLE_NAME` | Target AWS storage resources |
| `API_URL` | Used to build the `Location` header on fragment creation |
| `FRAGMENTS_LOG_LEVEL` | Pino log level (`info` in production, `debug` for troubleshooting) |
| `AWS_SQS_QUEUE_URL` | Enables async jobs: the SQS queue the API sends to and the worker reads from. Without it `POST .../jobs` answers `501` |
| `AWS_DYNAMODB_JOBS_TABLE_NAME` | DynamoDB table holding job records |
| `AWS_DYNAMODB_EMBEDDINGS_TABLE_NAME` | Enables search: DynamoDB table holding the search index. Without it `GET /v1/search` answers `501` |
| `EMBEDDER` / `EMBEDDING_DIMENSIONS` | `fake` uses the local word-hashing embedder instead of Bedrock; vector size (default `256`) |
| `AWS_SQS_ENDPOINT_URL` | Alternate SQS endpoint (MiniStack) for local runs |
| `JOB_MAX_ATTEMPTS` / `JOB_LEASE_SECONDS` | Attempts before a job fails (default `3`, matches the queue's redrive count) and how long a worker may hold a job (default `110` s, just under the queue's 120 s visibility timeout) |
| `MAX_IMAGE_PIXELS` | Largest image (width x height) that will be converted or resized (default 16,000,000). Larger images are refused with `422`; found by load testing, see `docs/perf/baseline.md` |
| `MAX_CONCURRENT_IMAGE_CONVERSIONS` | Image conversions allowed at once (default `2`). Extra requests get `503` with `Retry-After` |
