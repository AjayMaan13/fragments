# Fragments

A cloud-native microservice for storing, converting, and serving small pieces of data ("fragments") — text, JSON, and images — with authenticated multi-user access, deployed as an auto-scaling, containerized service on AWS.

Built as a full CI/CD-driven production system: every push runs a full test suite; every tagged release automatically builds a Docker image, pushes it to a container registry, and rolls it out to a live AWS deployment with zero manual intervention.

**Live API:** `https://fragments.asmaan4.mystudentproject.ca` (custom domain + TLS) — also reachable at the raw load-balancer URL `http://fragments-lb-1603159740.us-east-2.elb.amazonaws.com`
**Companion UI:** [fragments-ui](https://github.com/AjayMaan13/fragments-ui)

---

## What it does

- Authenticated users can create, read, update, and delete "fragments" of data via a REST API
- Supports 11 content types: `text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/yaml`, and 5 image formats (`png`, `jpeg`, `webp`, `avif`, `gif`)
- Converts fragments on read between compatible formats — markdown → HTML, JSON ↔ YAML, CSV → JSON, and any image format → any other image format (via `sharp`/libvips) — without ever storing more than one copy of the data
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
        ALB[Application Load Balancer]
        subgraph ECS["ECS Fargate Service"]
            Task1[fragments task]
        end
        S3[(Amazon S3<br/>fragment data)]
        Dynamo[(Amazon DynamoDB<br/>fragment metadata)]
        CW[CloudWatch Logs]
        ECR[(Amazon ECR<br/>image registry)]
    end

    subgraph CICD["GitHub Actions"]
        CI[CI: lint, unit + integration tests,<br/>Docker Hub push]
        CD[CD: build, push to ECR,<br/>render + deploy ECS task def]
    end

    UI -- OAuth login --> Cognito
    UI -- Bearer token --> ALB
    ALB --> Task1
    Task1 --> S3
    Task1 --> Dynamo
    Task1 --> CW
    CD -- git tag push --> ECR
    ECR --> Task1
    CD -- deploys --> ECS
```

## AWS services used

| Service | Role |
|---|---|
| **ECS (Fargate)** | Serverless container orchestration — runs the API with no managed EC2 instances |
| **ECR** | Private Docker image registry, pulled by ECS on deploy |
| **Elastic Load Balancing (ALB)** | Public entry point, routes traffic to healthy ECS tasks, enables horizontal scaling |
| **S3** | Stores fragment binary data (text and image bytes) |
| **DynamoDB** | Stores fragment metadata (id, type, size, timestamps), on-demand billing |
| **Cognito** | User authentication via OAuth 2.0 / OIDC Hosted UI, JWT bearer tokens verified server-side |
| **IAM** | Task role + execution role scoping what the running container can access |
| **CloudWatch Logs** | Centralized structured logging (Pino JSON logs) for every request, shipped from each container |
| **VPC** | Default VPC with public subnets across 2 Availability Zones for fault tolerance |
| **Certificate Manager (ACM)** | Imported Let's Encrypt certificate serving the custom HTTPS domain via an ALB HTTPS:443 listener, with HTTP→HTTPS 301 redirect |

## Tech stack

- **Runtime:** Node.js, Express
- **Auth:** Passport (HTTP Basic strategy + Bearer/Cognito JWT strategy), `aws-jwt-verify`
- **Data:** `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`
- **Conversions:** `sharp` (image transcoding via libvips), `js-yaml`, `csvtojson`, `markdown-it`
- **Logging:** Pino (structured JSON logs, pretty-printed locally)
- **Security:** Helmet (security headers), CORS
- **Testing:** Jest (unit), Hurl (HTTP integration tests), Docker Compose with DynamoDB Local + MiniStack (S3-compatible mock) for local AWS-parity testing
- **CI/CD:** GitHub Actions — lint, Dockerfile lint (hadolint), unit tests, integration tests, Docker Hub publish on every push to `main`; ECR publish + automated ECS rolling deployment on every version tag
- **Containerization:** Multi-stage Dockerfile, production dependencies only in the final image

## Engineering highlights

- **~92% statement / ~92% line test coverage**, 125 unit tests + 14 Hurl integration test files (43 requests) covering every route, every conversion path, and both success and error cases
- **Zero-downtime rolling deployments** — pushing a git tag triggers an automated pipeline that builds, tests, and deploys a new ECS task revision while the old one keeps serving traffic until the new one is healthy
- **Environment-driven configuration** — the identical codebase runs against an in-memory store locally and real AWS infrastructure in production, switched purely by which environment variables are present, with zero conditional deploy-target code
- **Content-negotiated conversions** — a single stored fragment can be requested back in any compatible format via a URL extension (e.g. `.html`, `.yaml`, `.jpg`), computed on-the-fly rather than stored redundantly
- **Custom domain over TLS** — served at a Seneca `mystudentproject.ca` subdomain via a Let's Encrypt certificate in ACM, an ALB HTTPS listener, and an automatic HTTP→HTTPS 301 redirect

## API overview

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Health check (includes server hostname, useful for verifying load balancing) |
| `POST` | `/v1/fragments` | Create a new fragment |
| `GET` | `/v1/fragments` | List the authenticated user's fragments (`?expand=1` for full metadata) |
| `GET` | `/v1/fragments/:id` | Get a fragment's raw data |
| `GET` | `/v1/fragments/:id.ext` | Get a fragment converted to another supported format |
| `GET` | `/v1/fragments/:id/info` | Get a fragment's metadata only |
| `PUT` | `/v1/fragments/:id` | Replace a fragment's data (its type is immutable) |
| `DELETE` | `/v1/fragments/:id` | Delete a fragment |

All `/v1/*` routes require authentication (HTTP Basic locally, or a Cognito bearer token in production).

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
