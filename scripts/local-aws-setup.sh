#!/bin/sh

# Setup steps for working with MiniStack and DynamoDB local instead of AWS.
# Assumes aws cli is installed and MiniStack and DynamoDB local are running.

# Setup AWS environment variables
echo "Setting AWS environment variables for MiniStack"

echo "AWS_ACCESS_KEY_ID=test"
export AWS_ACCESS_KEY_ID=test

echo "AWS_SECRET_ACCESS_KEY=test"
export AWS_SECRET_ACCESS_KEY=test

export AWS_DEFAULT_REGION=us-east-2
echo "AWS_DEFAULT_REGION=us-east-2"

# Wait for MiniStack to be ready, by inspecting the response from healthcheck
echo 'Waiting for MiniStack S3...'
until (curl --silent http://localhost:4566/_ministack/health | grep "\"s3\": \"\(running\|available\)\"" > /dev/null); do
    sleep 5
done
echo 'MiniStack S3 Ready'

echo 'Waiting for MiniStack SQS...'
until (curl --silent http://localhost:4566/_ministack/health | grep "\"sqs\": \"\(running\|available\)\"" > /dev/null); do
    sleep 5
done
echo 'MiniStack SQS Ready'

# Create our S3 bucket with MiniStack
echo "Creating MiniStack S3 bucket: fragments"
aws --endpoint-url=http://localhost:4566 s3api create-bucket --bucket fragments

# Setup DynamoDB Table with dynamodb-local, see:
# https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/getting-started-step-1.html
echo "Creating DynamoDB-Local DynamoDB table: fragments"
aws --endpoint-url=http://localhost:8000 \
dynamodb create-table \
    --table-name fragments \
    --attribute-definitions \
        AttributeName=ownerId,AttributeType=S \
        AttributeName=id,AttributeType=S \
    --key-schema \
        AttributeName=ownerId,KeyType=HASH \
        AttributeName=id,KeyType=RANGE \
    --provisioned-throughput \
        ReadCapacityUnits=10,WriteCapacityUnits=5

# Wait until the Fragments table exists in dynamodb-local, so we can use it, see:
# https://awscli.amazonaws.com/v2/documentation/api/latest/reference/dynamodb/wait/table-exists.html
aws --endpoint-url=http://localhost:8000 dynamodb wait table-exists --table-name fragments

# Async conversion jobs: a dead-letter queue, the jobs queue that feeds it after
# 3 failed deliveries (same numbers as infra/modules/queue), and the jobs table.
echo "Creating MiniStack SQS queues: fragments-jobs-dlq and fragments-jobs"
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name fragments-jobs-dlq
DLQ_ARN=$(aws --endpoint-url=http://localhost:4566 sqs get-queue-attributes \
    --queue-url http://localhost:4566/000000000000/fragments-jobs-dlq \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name fragments-jobs \
    --attributes "{\"VisibilityTimeout\":\"120\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

echo "Creating DynamoDB-Local DynamoDB table: fragments-jobs"
aws --endpoint-url=http://localhost:8000 \
dynamodb create-table \
    --table-name fragments-jobs \
    --attribute-definitions \
        AttributeName=ownerId,AttributeType=S \
        AttributeName=jobId,AttributeType=S \
    --key-schema \
        AttributeName=ownerId,KeyType=HASH \
        AttributeName=jobId,KeyType=RANGE \
    --provisioned-throughput \
        ReadCapacityUnits=10,WriteCapacityUnits=5
aws --endpoint-url=http://localhost:8000 dynamodb wait table-exists --table-name fragments-jobs
