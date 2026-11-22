# Fragments: Terraform + Feature Expansion Plan

Goal: rebuild the existing AWS infra as Terraform, add seven small features on top,
and end up with a system you can bring up before you work on it and tear down
(`terraform destroy`) when you're done, so cost stays near $0 the rest of the time.

This is a learning-oriented roadmap, not a script to paste in. Each phase says what
to build, what Terraform/AWS concepts it teaches, and why it's ordered where it is.
Build phases in order — each one depends on state from the last.

---

## 0. What you're keeping vs. adding

**Keeping (all of it):** 11 content types + conversions, swappable auth (Basic/Cognito)
and storage (memory/S3+DynamoDB) backends, the CRUD API, ECS Fargate + ALB deployment,
custom domain + TLS, CI/CD via GitHub Actions. None of this changes — you're just
changing *how the infra gets created* (Terraform instead of console clicks) and
*adding* to the app on top of it.

**Adding:**

| Feature | New AWS infra? | Where it lives |
|---|---|---|
| Content expansion (PDF/DOCX/XML) | No | App code only |
| Expiring fragments | No — reuses DynamoDB | Terraform: one `ttl` block. App: one field |
| View counter | No — reuses DynamoDB | App code only |
| Public share link | No — reuses S3 | App code only |
| Image thumbnail | No — reuses `sharp` | App code only |
| QR code | No | App code (as a new conversion type) |
| Event-driven side effect | **Yes — Lambda** | Terraform: new `events` module |

Six of seven features need zero new infrastructure — they're extensions of clients
and tables you already provisioned manually. Only the event-driven piece introduces
something genuinely new (Lambda). That's intentional: it keeps the Terraform surface
close to what you already understand from building this manually, with one new
concept (serverless event triggers) layered in.

---

## 1. Terraform module layout

```
fragments/
└── infra/
    ├── bootstrap/                 # run once, ever — never destroyed
    │   └── main.tf                # state bucket + lock table
    ├── main.tf                    # root module: wires everything below together
    ├── variables.tf
    ├── outputs.tf
    ├── terraform.tfvars           # gitignored — your account-specific values
    ├── backend.tf                 # points at the bootstrap bucket/table
    └── modules/
        ├── network/                # security groups only (reference the default VPC)
        ├── ecr/                    # image registry
        ├── iam/                    # ECS task role + execution role
        ├── storage/                # S3 bucket (fragment data) + DynamoDB table (+ TTL)
        ├── alb/                    # load balancer, target group, HTTPS listener
        ├── ecs/                    # cluster, task definition, service
        ├── auth/                   # Cognito user pool + app client + hosted UI
        ├── dns-tls/                # ACM cert reference, listener cert attach
        └── events/                 # Lambda + S3 event notification (new)
```

**Why a `bootstrap/` outside the main stack:** Terraform's own state has to live
*somewhere* before Terraform can manage anything — you can't store the state file
that tracks your S3 bucket *inside* that same S3 bucket's own stack, or destroying
the stack destroys the thing tracking what to destroy. `bootstrap/` creates a small
S3 bucket (state) + DynamoDB table (state locking) once, by hand-running
`terraform apply` in that folder a single time, and you never touch it again. This
also gives you a second, very deliberate use of DynamoDB, which is a nice thing to
be able to explain in a course writeup.

**Why `network/` only has security groups:** you're already running fine on the
default VPC. Creating a whole new VPC is realistic for a "real" production setup but
is pure extra surface area for a course project — use
`data "aws_vpc" "default"` and `data "aws_subnets"` to *reference* what's there
instead of creating new networking. You'll still write security group resources
(ALB ingress 443/80, ECS task ingress from the ALB's security group only) — that's
the part actually worth doing in Terraform.

---

## 2. Phased build order

### Phase 0 — Foundations (before any AWS resource)
- Install Terraform, confirm `aws configure` / your CLI credentials work.
- `cd infra/bootstrap && terraform init && terraform apply` — creates the state
  bucket + lock table. This is the only `apply` you run outside the main stack.
- **Learn:** providers, `terraform init`, remote state, state locking — why two
  people (or two terminal tabs) running `apply` at once would corrupt local state,
  and how the DynamoDB lock table prevents that.

### Phase 1 — Registry + IAM
- `modules/ecr`: one `aws_ecr_repository`.
- `modules/iam`: task execution role (pulls image, writes logs) and task role
  (what the *running app* can touch — S3 bucket, DynamoDB table). Two separate
  roles on purpose: least privilege — the thing that starts your container doesn't
  need the same permissions as your container's own code.
- **Learn:** IAM trust policies vs. permission policies, why ECS needs two roles.

### Phase 2 — Storage
- `modules/storage`: `aws_s3_bucket` (fragment bytes) with `force_destroy = true`
  so `terraform destroy` can remove it even if it still has objects in it — without
  this flag, destroy fails on a non-empty bucket and you have to empty it by hand.
- `aws_dynamodb_table` matching your existing schema (`ownerId` hash key, `id`
  range key), **plus** a `ttl { attribute_name = "expiresAt", enabled = true }`
  block. This one block is your entire "expiring fragments" infrastructure —
  DynamoDB does the deletion for you in the background (usually within ~48h of
  the timestamp passing; it's not instant, which is worth knowing so you don't
  build a demo that expects sub-second expiry).
- **Learn:** DynamoDB TTL, S3 bucket lifecycle at the Terraform level.

### Phase 3 — Networking + compute
- `modules/network`: security groups (ALB: 80/443 from anywhere; ECS task: app
  port from the ALB's SG only — not from the internet directly).
- `modules/alb`: ALB, target group (health check on `/`), HTTPS listener
  (references the ACM cert from `dns-tls`), HTTP→HTTPS redirect listener.
- `modules/ecs`: cluster, task definition (container image from ECR, env vars for
  region/bucket/table names as Terraform outputs from Phase 2, wired via
  `aws_ecs_task_definition` `container_definitions` JSON), service (desired count
  1, attached to the ALB target group).
- **Learn:** how Fargate tasks get IPs in a public subnet, target group health
  checks, how a task definition's env vars are how you're already doing
  "environment-driven configuration" per your own README — now the environment
  itself is generated by Terraform instead of typed into the console.

### Phase 4 — Auth
- `modules/auth`: Cognito user pool, app client, hosted UI domain — same shape as
  what you clicked together manually, now declared. Output the pool ID/client ID
  as Terraform outputs so you can drop them straight into the ECS task def's env
  vars in Phase 3 (small chicken-and-egg note: you'll wire this output back into
  the `ecs` module call in root `main.tf`).
- **Learn:** module outputs feeding into other modules' inputs — this is the first
  point where you'll feel *why* modules exist instead of one giant file.

### Phase 5 — DNS/TLS (DECISION: deferred; will use CloudFront instead)
The new AWS account has no domain (the old one used a Seneca subdomain), so
instead of the ACM-on-ALB approach below, the plan is a `modules/cdn`
CloudFront distribution in front of the ALB: free HTTPS on a
`*.cloudfront.net` address, no domain purchase. It must forward the
`Authorization` header and disable caching for API routes. The CloudFront→ALB
hop stays HTTP. Not required for anything to work while the UI runs on
localhost; needed only if the UI is deployed publicly. Original plan, kept
for reference if a domain is bought later:
- `modules/dns-tls`: reference your existing imported Let's Encrypt cert via
  `data "aws_acm_certificate"` (don't recreate it — importing a cert into Terraform
  as a *new* resource would require re-uploading the private key). If you'd rather
  learn the AWS-native path, this is also where you'd swap to
  `aws_acm_certificate` + DNS validation instead, but that's optional scope.
- **Learn:** `data` sources — referencing infra that already exists vs. `resource`
  blocks that create new infra. You've used `data` for the default VPC already;
  this reinforces it.

### Phase 6 — Application features (no new infra)
Do these directly in the app code, deployed on top of what Phases 1–5 built.
Suggested build order, with what each touches in the current codebase:

| # | Feature | Files touched | Effort | New infra? |
|---|---|---|---|---|
| 1 | **Expiring fragments** | `fragment.js` (new `expiresAt` field), `post.js` (accept it), `getId.js`/`getIdInfo.js` (treat expired as 404) | Small | No, TTL is already on the table |
| 2 | **View counter** | `data/aws/index.js` (new `incrementViews` using `UpdateCommand` with `ADD`), `getId.js`, `getIdInfo.js` (show the count) | Small | No, `UpdateItem` is already permitted in IAM |
| 3 | **Public share link** | new route `GET /v1/fragments/:id/share`, `@aws-sdk/s3-request-presigner` | Small–medium | No |
| 4 | **Image thumbnails** | the conversion code in `getId.js`, a `?width=` param through `sharp` | Small | No |
| 5 | **QR code** | conversion extension `.qr` in `getId.js`, the `qrcode` npm package | Small | No |
| 6 | **Content expansion** (PDF, DOCX, XML) | `fragment.js` (`supportedTypes` and `formats` map), `getId.js`, new libraries | Medium–large | No |
| 7 | **Event-driven side effect** | Lambda + S3 notification in a new Terraform `events` module | Medium | **Yes** (this is Phase 7) |

The individual items:

- **Content expansion:** add PDF/DOCX/XML to the existing conversion map — same
  pattern as your current markdown→HTML/JSON↔YAML paths, new libraries
  (`pdf-lib` or similar for PDF, `docx` for Word output).
- **View counter:** an atomic `UpdateItem` with an `ADD viewCount :one` expression
  on `GET /v1/fragments/:id` — DynamoDB handles the atomicity, no read-modify-write
  race condition to worry about.
- **Expiring fragments:** accept an optional `expiresAt` at creation, store it as
  the TTL attribute from Phase 2.
- **Image thumbnail:** a `?width=` query param (or `.thumb.<ext>` route) that adds
  one `.resize()` call to your existing `sharp` pipeline.
- **Public share link:** new route, `GET /v1/fragments/:id/share`, using
  `@aws-sdk/s3-request-presigner`'s `getSignedUrl` against your existing S3
  client — returns a time-limited public URL, no new IAM permissions needed since
  it signs with the same credentials your task role already has.
- **QR code:** treat it as a new *conversion extension* rather than a separate
  feature — `GET /v1/fragments/:id.qr` generates a QR-code PNG (via the `qrcode`
  npm package) encoding the share link from the point above. This fits your
  existing content-negotiation pattern instead of being a bolt-on.
- **Learn:** nothing new on the infra side — this phase is where you'll feel the
  payoff of "environment-driven config, zero conditional deploy code" from your
  own README: none of this needed a new AWS resource because the app was already
  wired to the right clients.

### Phase 7 — Event-driven side effect (the one new infra piece)
- `modules/events`: an `aws_lambda_function` (small Node.js handler), an
  `aws_iam_role` for it (execution role, permission to read the S3 object that
  triggered it and to call an outbound webhook), an `aws_s3_bucket_notification`
  on the fragments bucket for `s3:ObjectCreated:*`, and an `aws_lambda_permission`
  granting S3 permission to invoke the function.
- Handler logic: on a new object landing in S3, POST a small JSON payload to a
  webhook URL (Discord or Slack both have dead-simple incoming webhooks) — "new
  fragment created: `<type>`, `<size>` bytes."
- **Learn:** event-driven serverless end to end — S3 event source → Lambda
  trigger permission → Lambda execution role → outbound call. This is the one
  place where "Terraform describes something that wasn't in your manual setup at
  all," which is worth calling out explicitly in a writeup: IaC didn't just
  reproduce what you had, it made a genuinely new AWS integration a ~30-line
  module instead of a multi-step console wizard.

### Phase 8 — CI/CD
- Add a `terraform plan` (on PR, posted as a comment) and `terraform apply` (on
  merge to `main` or on tag, matching your existing CD trigger) step to your
  existing GitHub Actions workflow, right alongside the Docker build/push you
  already have.
- **Learn:** IaC inside CI — plan as a review artifact, apply as the actual
  deploy step, same discipline you already apply to code via tests.

### Phase 9 — The up/down habit
- `terraform apply` before you sit down to work or before a grading session.
- `terraform destroy` when you're done for the day.
- Practice this cycle at least twice before you rely on it for grading, so you're
  confident it comes back up clean (this is also where you'll catch anything you
  forgot to parameterize, like a hardcoded ARN).

---

## 3. Approximate cost

Assuming light/demo-scale usage (a handful of fragments, a few requests per
session, not sustained traffic):

| Service | Cost driver | If left running 24/7 | If destroyed between sessions |
|---|---|---|---|
| ALB | hourly + LCU | ~$16–20/mo | $0 |
| ECS Fargate (0.25 vCPU/0.5GB, 1 task) | hourly | ~$9–10/mo | $0 |
| ECR | image storage | ~$0.05–0.20/mo | ~same (small, keep or destroy) |
| S3 | storage + requests | <$0.05/mo | $0 |
| DynamoDB (on-demand) | requests + storage | $0 (free tier covers this scale) | $0 |
| Cognito | MAUs | $0 (free under 50,000 MAUs) | $0 |
| CloudWatch Logs | ingestion/storage | $0–cents (free tier: 5GB) | $0 |
| Lambda | invocations | $0 (free tier: 1M req/mo) | $0 |
| ACM | — | $0 (always free) | $0 |

**Bottom line:** the ALB and the Fargate task are the only components that cost
anything meaningful, and both only bill while running. If you actually follow the
apply/destroy habit from Phase 9, total spend should stay under **$1–2/month**,
likely **$0** if you're within the AWS Free Tier window on this account. Leaving
it up continuously for a full month would run **roughly $25–35/month**, almost
entirely the ALB + Fargate task — everything else in the table is noise by
comparison.

Keep `bootstrap/` (state bucket + lock table) running permanently — it costs
cents a month and losing it means losing track of everything else.

---

## 4. Before you start tomorrow

1. Confirm AWS CLI auth works (`aws sts get-caller-identity`).
2. Decide: keep the manually-created resources running in parallel while you
   build the Terraform versions (safer, costs a bit more temporarily), or delete
   them first and rebuild fresh (cheaper, but the API is down until Phase 3 is
   done). For a course project with time pressure, running in parallel and
   cutting over the DNS record at the end is the less stressful path.
3. Work phase by phase, `terraform plan` before every `apply` so you can read
   exactly what's about to change before it happens.
