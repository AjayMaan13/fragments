# Fragments

A cloud-native microservice for storing, converting, and serving small pieces of data ("fragments") — text, JSON, and images — with authenticated multi-user access, deployed as an auto-scaling, containerized service on AWS.

Built as a full CI/CD-driven production system: every push runs a full test suite; every tagged release automatically builds a Docker image, pushes it to a container registry, and rolls it out to a live AWS deployment with zero manual intervention.

**Demo video:** https://youtu.be/YJZaokns0F0
**Deployment:** on demand — the whole environment is created with `terraform apply` and torn down when not in use (see [Deploying to AWS](#deploying-to-aws)); the API's load-balancer URL is printed by `terraform output api_url`
**Companion UI:** [fragments-ui](https://github.com/AjayMaan13/fragments-ui)

---

## What it does

- Authenticated users can create, read, update, and delete "fragments" of data via a REST API
- Supports 12 content types: `text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/yaml`, `application/xml`, and 5 image formats (`png`, `jpeg`, `webp`, `avif`, `gif`)
- Converts fragments on read between compatible formats — markdown → HTML, JSON ↔ YAML, JSON ↔ XML, CSV → JSON, any image format → any other image format (via `sharp`/libvips), and markdown or plain text → PDF (`.pdf`) or Word (`.docx`) — without ever storing more than one copy of the data
- Fragments can **expire** (`?expiresIn=<seconds>`): they disappear from reads and lists immediately, and DynamoDB TTL plus a Lambda then delete the stored data from S3
- Counts **views** of each fragment, atomically, using a DynamoDB counter
- Creates **temporary public share links** (pre-signed S3 URLs, capped at 1 hour and at the fragment's own expiry)
- Shrinks images on the fly for **thumbnails** (`?width=<pixels>`)
- Two swappable backends, controlled entirely by environment variables, no code changes required:
  - **Auth:** HTTP Basic (local dev) or Amazon Cognito (production)
  - **Storage:** in-memory (local dev) or Amazon S3 + DynamoDB (production)

## Architecture

```mermaid
flowchart LR
    subgraph Client
        UI[fragments-ui<br/>browser app]
    end

    subgraph Auth
        Cognito[Amazon Cognito<br/>User Pool + Hosted UI]
    end

    subgraph AWS["AWS — us-east-2"]
        ALB[Application Load Balancer<br/>HTTP:80]
        subgraph ECS["ECS Fargate Service"]
            Task1[fragments task]
        end
        S3[(Amazon S3<br/>fragment data)]
        Dynamo[(Amazon DynamoDB<br/>fragment metadata + TTL)]
        Lambda[Lambda<br/>expired-fragment cleanup]
        CW[CloudWatch Logs]
        ECR[(Amazon ECR<br/>image registry)]
    end

    subgraph CICD["GitHub Actions"]
        CI[CI: lint, unit + integration tests,<br/>Docker Hub push]
        CD[CD: build, push to ECR,<br/>deploy ECS task def via OIDC]
    end

    subgraph IaC["Terraform"]
        TF[infra/ modules:<br/>all AWS resources above]
    end

    UI -- OAuth login --> Cognito
    UI -- Bearer token --> ALB
    ALB --> Task1
    Task1 --> S3
    Task1 --> Dynamo
    Dynamo -- "TTL delete (stream)" --> Lambda
    Lambda -- deletes expired data --> S3
    Task1 --> CW
    CD -- git tag push --> ECR
    ECR -- image pulled by --> Task1
    CD -- deploys task def --> Task1
    TF -. provisions .-> AWS
```

## AWS services used

| Service | Role |
|---|---|
| **ECS (Fargate)** | Serverless container orchestration — runs the API with no managed EC2 instances |
| **ECR** | Private Docker image registry, pulled by ECS on deploy |
| **Elastic Load Balancing (ALB)** | Public entry point, routes traffic to healthy ECS tasks, enables horizontal scaling (HTTP; HTTPS is not enabled) |
| **S3** | Stores fragment binary data (text and image bytes) |
| **DynamoDB** | Stores fragment metadata (id, type, size, timestamps, view count, expiry), on-demand billing; TTL expires fragments and a stream reports the deletions |
| **Lambda** | Deletes an expired fragment's data from S3 when DynamoDB's TTL removes its record |
| **Cognito** | User authentication via OAuth 2.0 / OIDC Hosted UI, JWT bearer tokens verified server-side |
| **IAM** | Least-privilege task and execution roles, plus a GitHub OIDC deploy role so CI needs no stored AWS keys |
| **CloudWatch Logs** | Centralized structured logging (Pino JSON logs) for every request, shipped from each container |
| **VPC** | Default VPC with public subnets across 2 Availability Zones for fault tolerance |

## Tech stack

- **Runtime:** Node.js, Express
- **Auth:** Passport (HTTP Basic strategy + Bearer/Cognito JWT strategy), `aws-jwt-verify`
- **Data:** `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`
- **Conversions:** `sharp` (image transcoding and resizing via libvips), `js-yaml`, `csvtojson`, `markdown-it`, `fast-xml-parser` (XML), `pdfkit` (PDF), `docx` (Word)
- **Infrastructure:** Terraform (modules for network, ALB, ECS, storage, auth, events, CI/CD)
- **Logging:** Pino (structured JSON logs, pretty-printed locally)
- **Security:** Helmet (security headers), CORS
- **Testing:** Jest (unit), Hurl (HTTP integration tests), Docker Compose with DynamoDB Local + MiniStack (S3-compatible mock) for local AWS-parity testing
- **CI/CD:** GitHub Actions — lint, Dockerfile lint (hadolint), unit tests, integration tests, Docker Hub publish on every push to `main`; a Terraform format/validate check; on every version tag, an ECR publish and automated ECS rolling deployment authenticated with GitHub OIDC (no stored AWS keys)
- **Containerization:** Multi-stage Dockerfile, production dependencies only in the final image

## Engineering highlights

- **~95% line test coverage**, 195 unit tests + 14 Hurl integration test files covering every route, every conversion path, and both success and error cases
- **Zero-downtime rolling deployments** — pushing a git tag triggers an automated pipeline that builds, tests, and deploys a new ECS task revision while the old one keeps serving traffic until the new one is healthy
- **Environment-driven configuration** — the identical codebase runs against an in-memory store locally and real AWS infrastructure in production, switched purely by which environment variables are present, with zero conditional deploy-target code
- **Content-negotiated conversions** — a single stored fragment can be requested back in any compatible format via a URL extension (e.g. `.html`, `.yaml`, `.jpg`), computed on-the-fly rather than stored redundantly
- **Everything as code** — every AWS resource is defined in Terraform, so the whole environment can be created (or destroyed to stop billing) with one command; CI/CD only ships images

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
| `PUT` | `/v1/fragments/:id` | Replace a fragment's data (its type is immutable) |
| `DELETE` | `/v1/fragments/:id` | Delete a fragment |

Image fragments accept `?width=<pixels>` on reads (with or without an extension) to return a smaller copy, e.g. `/v1/fragments/:id.webp?width=200`.

All `/v1/*` routes require authentication (HTTP Basic locally, or a Cognito bearer token in production).

---

## Deploying to AWS

All infrastructure is defined in `infra/` (Terraform); CI/CD only ships new images. To stand it up in a fresh AWS account:

1. Install [Terraform](https://developer.hashicorp.com/terraform/install) and run `aws configure` for the target account.
2. `cd infra && terraform init && terraform apply` — creates ECR, S3, DynamoDB (with TTL, a stream and a cleanup Lambda), Cognito, the load balancer, an ECS service (0 tasks for now) and the GitHub deploy role.
3. In the GitHub repo, add an Actions **variable** `AWS_DEPLOY_ROLE_ARN` set to `terraform output github_deploy_role_arn`.
4. Push a version tag (`npm version patch && git push --follow-tags`). The `cd` workflow builds and pushes the image to ECR and deploys it.
5. `terraform apply -var desired_count=1` starts the service. Copy `api_url` and the Cognito values from `terraform output` into `fragments-ui/.env`.

To stop billing, `terraform destroy -target=module.ecs -target=module.alb` removes only the load balancer and service (data and users are kept); `terraform destroy` removes everything.

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
  "version": "0.7.2",
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
