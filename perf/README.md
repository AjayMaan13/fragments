# Load tests (k6)

| File | Purpose |
|---|---|
| `smoke.js` | Health, create, read back, delete. Runs in CI (`perf-smoke` job) and by hand. Not a benchmark. |
| `mixed.js` | Fixed-arrival-rate staircase with a weighted request mix (cheap reads / small conversions / heavy image conversion). This is the baseline measurement. |
| `make-fixtures.js` | Generates the image files the tests need into `perf/fixtures/` (git-ignored). |
| `lib/common.js` | Base URL and login (Basic auth locally, Cognito `InitiateAuth` on AWS). |

Raw k6 output goes to `perf/results/` (git-ignored). Copy the runs you quote into `docs/perf/` and commit those.

## One-time setup

```bash
brew install k6                 # or see https://grafana.com/docs/k6/latest/set-up/install-k6/
node perf/make-fixtures.js      # writes perf/fixtures/heavy.jpg
```

## Run locally (docker compose, Basic auth)

```bash
docker compose up -d && ./scripts/local-aws-setup.sh
k6 run perf/smoke.js
```

Local numbers only prove the scripts work. Your laptop is not a 0.25 vCPU Fargate task, so **do not quote them as service performance**.

## Run against AWS

All of this costs real money while it runs. The task is 0.25 vCPU / 512 MB, one task.

### 0. Budget alert first

Replace the email, then run once per account (it persists across `terraform destroy`).

```bash
aws budgets create-budget \
  --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget '{"BudgetName":"fragments-load-test","BudgetLimit":{"Amount":"10","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"YOU@example.com"}]}]'
```

### 1. Bring the stack up with this version's code

The ALB and ECS service need an image that has the Phase 1 code (request IDs and the conversion metric) in ECR. Pushing a `v*` tag runs `cd.yml`, which builds and pushes it.

```bash
cd infra
terraform apply \
  -var desired_count=1 \
  -var enable_password_auth=true \
  -var alarm_email=YOU@example.com
# click the SNS confirmation link AWS emails you, or no alarm email is ever sent
terraform output api_url dashboard_url cognito_client_id
```

`enable_password_auth=true` adds `ALLOW_USER_PASSWORD_AUTH` to the Cognito app client so k6 can log in with a username and password. It is **off by default**; turn it back off after testing (step 5).

### 2. Create a load-test user

Pool usernames are email addresses. Pick your own password (min 8 chars, upper, lower, number, symbol).

```bash
POOL=$(terraform -chdir=infra output -raw cognito_user_pool_id)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username loadtest@example.com \
  --message-action SUPPRESS \
  --user-attributes Name=email,Value=loadtest@example.com Name=email_verified,Value=true
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" \
  --username loadtest@example.com --password '<your password>' --permanent
```

### 3. Run

```bash
export AUTH_MODE=cognito
export BASE_URL=$(terraform -chdir=infra output -raw api_url)
export COGNITO_CLIENT_ID=$(terraform -chdir=infra output -raw cognito_client_id)
export COGNITO_USERNAME=loadtest@example.com COGNITO_PASSWORD='<your password>'

k6 run perf/smoke.js
# Experiment 1: cheap reads only, find the knee
READ_PCT=100 CONVERT_PCT=0 IMAGE_PCT=0 RATES=5,10,20,40,80 \
  k6 run --summary-export=perf/results/exp1-reads.json perf/mixed.js
# Experiment 2: with vs without heavy conversions, same read rate
RATES=20 STEP_SECONDS=180 k6 run --summary-export=perf/results/exp2-mixed.json perf/mixed.js
READ_PCT=100 CONVERT_PCT=0 IMAGE_PCT=0 RATES=20 STEP_SECONDS=180 \
  k6 run --summary-export=perf/results/exp2-reads-only.json perf/mixed.js
```

The ID token lasts 60 minutes; keep each run under that. `k6` exit code 99 means a threshold was crossed: that is information, not a crash.

### 4. Experiment 3: memory (small file, huge pixels)

```bash
node perf/make-fixtures.js --huge 16000x16000     # ~1 MB PNG, 256 megapixels
TOKEN=$(aws cognito-idp initiate-auth --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$COGNITO_USERNAME,PASSWORD=$COGNITO_PASSWORD" \
  --query AuthenticationResult.IdToken --output text)
ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: image/png' \
  --data-binary @perf/fixtures/huge-pixels.png "$BASE_URL/v1/fragments" | jq -r .fragment.id)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE_URL/v1/fragments/$ID.avif"
```

Watch the dashboard's ECS memory widget and `aws ecs describe-services` / stopped tasks while it runs. Record what happens in `docs/perf/baseline.md`.

### 5. Tear down

```bash
cd infra
terraform apply -var enable_password_auth=false -var desired_count=0   # or just destroy:
terraform destroy -target=module.ecs -target=module.alb                # also removes the dashboard and alarms
```

Delete the load-test Cognito user if you will not reuse it.
