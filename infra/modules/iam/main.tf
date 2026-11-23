# Trust policy: only the ECS tasks service is allowed to assume these roles
data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# What ECS itself needs: pull the image from ECR, write logs to CloudWatch.
# Runs before your application code starts.
resource "aws_iam_role" "task_execution_role" {
  name               = "${var.project_name}-task-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution_role_policy" {
  role       = aws_iam_role.task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# What your running application is allowed to touch (S3 bucket, DynamoDB
# table).
resource "aws_iam_role" "task_role" {
  name               = "${var.project_name}-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

# Least privilege: only the operations the app performs, only on our bucket/table.
data "aws_iam_policy_document" "task_data_access" {
  statement {
    sid       = "FragmentObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.bucket_arn}/*"]
  }

  # Without ListBucket, S3 answers a read of a missing key with 403 instead of 404.
  statement {
    sid       = "FragmentBucketList"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  statement {
    sid = "FragmentMetadataTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [var.table_arn]
  }
}

data "aws_region" "current" {}

# Search embeddings come from one Bedrock model, and nothing else in Bedrock is allowed
locals {
  embedding_model_arn = "arn:aws:bedrock:${data.aws_region.current.name}::foundation-model/amazon.titan-embed-text-v2:0"
}

# API: embed the query, read the owner's chunks, and remove a deleted fragment's chunks
data "aws_iam_policy_document" "task_search_access" {
  statement {
    sid       = "EmbeddingsTable"
    actions   = ["dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [var.embeddings_table_arn]
  }

  statement {
    sid       = "EmbedQuery"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.embedding_model_arn]
  }
}

resource "aws_iam_role_policy" "task_search_access" {
  name   = "${var.project_name}-task-search-access"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.task_search_access.json
}

# Jobs API: record a job and read it back, and queue it. The API does not
# process jobs, so it gets send only (no receive/delete).
data "aws_iam_policy_document" "task_jobs_access" {
  statement {
    sid       = "JobsTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [var.jobs_table_arn]
  }

  statement {
    sid       = "QueueJobs"
    actions   = ["sqs:SendMessage"]
    resources = [var.queue_arn]
  }
}

resource "aws_iam_role_policy" "task_jobs_access" {
  name   = "${var.project_name}-task-jobs-access"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.task_jobs_access.json
}

# The worker runs as its own role so it can take messages off the queue and
# write results, which the API must never do.
resource "aws_iam_role" "worker_role" {
  name               = "${var.project_name}-worker-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

data "aws_iam_policy_document" "worker_access" {
  statement {
    sid = "ReceiveJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.queue_arn]
  }

  # Read the fragment, write the result under results/
  statement {
    sid       = "FragmentAndResultObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.bucket_arn}/*"]
  }

  statement {
    sid       = "FragmentBucketList"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  # The worker only reads fragment metadata, never writes it
  statement {
    sid       = "ReadFragmentMetadata"
    actions   = ["dynamodb:GetItem"]
    resources = [var.table_arn]
  }

  statement {
    sid       = "JobsTable"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.jobs_table_arn]
  }
}

# The worker builds the index: embed each chunk, replace a fragment's chunks
data "aws_iam_policy_document" "worker_search_access" {
  statement {
    sid       = "EmbeddingsTable"
    actions   = ["dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [var.embeddings_table_arn]
  }

  statement {
    sid       = "EmbedChunks"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.embedding_model_arn]
  }
}

resource "aws_iam_role_policy" "worker_search_access" {
  name   = "${var.project_name}-worker-search-access"
  role   = aws_iam_role.worker_role.id
  policy = data.aws_iam_policy_document.worker_search_access.json
}

resource "aws_iam_role_policy" "worker_access" {
  name   = "${var.project_name}-worker-access"
  role   = aws_iam_role.worker_role.id
  policy = data.aws_iam_policy_document.worker_access.json
}

resource "aws_iam_role_policy" "task_data_access" {
  name   = "${var.project_name}-task-data-access"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.task_data_access.json
}
